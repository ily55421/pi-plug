/**
 * provider-balance 离线逻辑测试
 *
 * 用假的 `pi` 全局（含假的 net.fetch）加载 main.js，覆盖：
 *   1. 九家供应商的响应归一化（用上游 pi-agent-desktop 的测试夹具）
 *   2. 官方 origin 校验（自定义 baseUrl 必须被拒绝）
 *   3. 凭据解析（auth.json / models.json / 缺失）
 *   4. 单家失败不影响其他家
 *   5. net.fetch 只发往白名单端点，且 key 只出现在 Authorization 头
 *   6. 缓存快照里不含凭据
 *
 * 运行：node test-usage.cjs
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const usage = require("./lib/usage.js");

/* ------------------------------------------------------------ 测试框架 */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  FAIL " + name);
    console.log("       " + (error && error.message ? error.message : String(error)));
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  FAIL " + name);
    console.log("       " + (error && error.message ? error.message : String(error)));
  }
}

/* ------------------------------------------------------------ 假宿主 */

/** 记录每一次 net.fetch 的调用，供断言检查。 */
let fetchCalls = [];
/** 按端点 URL 返回预设响应。 */
let fetchResponses = new Map();
let settings = {};

function installFakeHost() {
  fetchCalls = [];
  fetchResponses = new Map();
  settings = {};

  globalThis.pi = {
    plugin: {
      getId: () => "local.provider-balance",
      getSettings: async () => JSON.parse(JSON.stringify(settings)),
      setSettings: async (value) => {
        settings = JSON.parse(JSON.stringify(value));
      },
      getDataPath: async () => "C:/fake/data",
    },
    net: {
      fetch: async (input) => {
        fetchCalls.push(input);
        const preset = fetchResponses.get(input.url);
        if (preset) return preset;
        return { status: 404, headers: {}, bodyText: "{}" };
      },
    },
    commands: {
      register: async () => {},
      unregister: async () => {},
    },
    ui: { showToast: async () => {} },
    app: { getAppearance: async () => ({ theme: "dark", base: "dark", locale: "zh-CN", pluginTheme: null }) },
  };
}

/* ============================================================ 1. 归一化 */

console.log("\n[1] 归一化：上游夹具");

test("Codex 的两个窗口归一化成剩余百分比与重置时间", () => {
  const r = usage.normalizePayload("openai-codex", {
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
    },
  }, 123);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.report.buckets.map((b) => [b.label, b.groupLabel, b.remaining, b.resetsAt]),
    [["5h", undefined, 88, 1_800_000_000], ["Weekly", undefined, 60, undefined]],
  );
});

test("MiniMax 用上报的 remaining percent 判定 count 语义，status=3 视为不限量", () => {
  const r = usage.normalizePayload("minimax", {
    model_remains: [{
      model_name: "MiniMax-M2",
      current_interval_usage_count: 20,
      current_interval_total_count: 100,
      current_interval_remaining_percent: 80,
      current_interval_status: 1,
      start_time: 1_700_000_000_000,
      end_time: 1_700_360_000_000,
      current_weekly_usage_count: 1,
      current_weekly_total_count: 1,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 3,
      weekly_start_time: 1_700_000_000_000,
      weekly_end_time: 1_706_000_000_000,
    }],
  }, 123);
  assert.equal(r.ok, true);
  assert.equal(r.report.buckets[0].remaining, 80);
  assert.equal(r.report.buckets[0].used, 20);
  assert.equal(r.report.buckets[1].period, "Unlimited");
});

test("OpenCode Go 的窗口转成剩余百分比", () => {
  const r = usage.normalizePayload("opencode-go", {
    usage: { rolling: { percent: 25, resetsAt: 1_800_000_000 }, weekly: { percent: 60 } },
  }, 123);
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.buckets.map((b) => [b.label, b.remaining]), [["Rolling", 75], ["Weekly", 40]]);
});

test("DeepSeek 余额保留原始字符串精度，不做浮点往返", () => {
  const r = usage.normalizePayload("deepseek", {
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "1234.5678", granted_balance: "0.00", topped_up_balance: "1234.5678" }],
  }, 123);
  assert.equal(r.ok, true);
  const total = r.report.metrics.find((m) => m.id === "cny-total");
  assert.equal(total.value, "1234.5678", "金额必须原样保留字符串");
  assert.equal(total.currency, "CNY");
});

test("OpenRouter 把 key limit 转成已用/剩余", () => {
  const r = usage.normalizePayload("openrouter", {
    data: { limit: 100, limit_remaining: 30, usage: 70, usage_daily: 1.5 },
  }, 123);
  assert.equal(r.ok, true);
  assert.equal(r.report.buckets[0].used, 70);
  assert.equal(r.report.buckets[0].remaining, 30);
});

test("Moonshot 余额在 code 非 0 时判为不成功", () => {
  const bad = usage.normalizePayload("moonshotai", { code: 1, status: false, data: null }, 123);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "UNSUCCESSFUL_RESPONSE");

  const good = usage.normalizePayload("moonshotai", {
    code: 0, status: true, data: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 },
  }, 123);
  assert.equal(good.ok, true);
  assert.equal(good.report.metrics.find((m) => m.id === "available").value, "12.5");
});

test("Vercel 余额与累计消费", () => {
  const r = usage.normalizePayload("vercel-ai-gateway", { balance: "5.00", total_used: "15.25" }, 123);
  assert.equal(r.ok, true);
  assert.equal(r.report.metrics.find((m) => m.id === "balance").value, "5.00");
  assert.equal(r.report.metrics.find((m) => m.id === "spent").value, "15.25");
});

test("空响应体判为 EMPTY_PAYLOAD 而不是抛错", () => {
  assert.equal(usage.normalizePayload("deepseek", {}, 1).ok, false);
  assert.equal(usage.normalizePayload("deepseek", {}, 1).reason, "EMPTY_PAYLOAD");
  assert.equal(usage.normalizePayload("openrouter", { data: {} }, 1).reason, "EMPTY_PAYLOAD");
});

test("未知供应商与非法载荷都返回结构化失败", () => {
  assert.equal(usage.normalizePayload("anthropic", { a: 1 }, 1).reason, "UNSUPPORTED_PROVIDER");
  assert.equal(usage.normalizePayload("deepseek", null, 1).reason, "NOT_AN_OBJECT");
  assert.equal(usage.normalizePayload("deepseek", [1, 2], 1).reason, "NOT_AN_OBJECT");
});

test("窗口标签：5 小时 / 每周 / 分钟", () => {
  assert.equal(usage.windowLabel(18_000), "5h");
  assert.equal(usage.windowLabel(604_800), "Weekly");
  assert.equal(usage.windowLabel(1_800), "30m");
  assert.equal(usage.windowLabel(undefined), "Limit");
});

/* ======================================================== 2. origin 校验 */

console.log("\n[2] 官方 origin 校验");

test("接受官方 origin，拒绝第三方 origin", () => {
  assert.equal(usage.isOfficialOrigin("deepseek", "https://api.deepseek.com/v1"), true);
  assert.equal(usage.isOfficialOrigin("deepseek", "https://proxy.example.com/v1"), false);
  assert.equal(usage.isOfficialOrigin("deepseek", "not a URL"), false);
  assert.equal(usage.isOfficialOrigin("deepseek", undefined), false);
  assert.equal(usage.isOfficialOrigin("opencode-go", "https://opencode.ai/zen/go/v1"), true);
  assert.equal(usage.isOfficialOrigin("opencode-go", "https://proxy.example.com/zen/go/v1"), false);
});

test("MiniMax 端点按 token 前缀分流", () => {
  assert.equal(usage.resolveEndpoint("minimax", "sk-api-xxx"), "https://api.minimax.io/account/query_balance");
  assert.equal(usage.resolveEndpoint("minimax", "other"), "https://api.minimax.io/v1/token_plan/remains");
  assert.equal(usage.resolveEndpoint("deepseek", "any"), "https://api.deepseek.com/user/balance");
});

/* ============================================================ 3. 凭据解析 */

console.log("\n[3] 凭据解析");

test("auth.json 的 api_key 优先", () => {
  const r = usage.resolveCredential("deepseek", {
    auth: { deepseek: { type: "api_key", key: "sk-from-auth" } },
    models: { providers: { deepseek: { apiKey: "sk-from-models" } } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.apiKey, "sk-from-auth");
  assert.equal(r.source, "auth.json");
});

test("auth.json 的 OAuth access token 可用", () => {
  const r = usage.resolveCredential("openai-codex", {
    auth: { "openai-codex": { type: "oauth", access: "oauth-token", refresh: "r" } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.apiKey, "oauth-token");
  assert.equal(r.source, "auth.json(oauth)");
});

test("回退到 models.json 的 apiKey 与 baseUrl", () => {
  const r = usage.resolveCredential("deepseek", {
    auth: {},
    models: { providers: { deepseek: { apiKey: "sk-models", baseUrl: "https://api.deepseek.com/v1" } } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.apiKey, "sk-models");
  assert.equal(r.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(r.source, "models.json");
});

test("没有任何凭据时返回 NO_CREDENTIAL", () => {
  assert.equal(usage.resolveCredential("deepseek", { auth: {}, models: {} }).reason, "NO_CREDENTIAL");
  assert.equal(usage.resolveCredential("deepseek", {}).reason, "NO_CREDENTIAL");
  assert.equal(usage.resolveCredential("anthropic", {}).reason, "UNSUPPORTED_PROVIDER");
});

/* ====================================================== 4. main.js 端到端 */

console.log("\n[4] main.js 端到端（假宿主）");

installFakeHost();
const main = require("./main.js");

/** 把假 pi 全局换成"有凭据"的版本：预置 auth.json 内容由 main 自己读。 */
function stubCredentialFiles(contents) {
  const realFs = require("node:fs");
  const original = realFs.readFileSync;
  realFs.readFileSync = (file, ...rest) => {
    const name = path.basename(String(file));
    if (Object.prototype.hasOwnProperty.call(contents, name)) return contents[name];
    return original.call(realFs, file, ...rest);
  };
  return () => {
    realFs.readFileSync = original;
  };
}

(async () => {
  await testAsync("无凭据时全部返回 no-credential，且不发任何请求", async () => {
    const restore = stubCredentialFiles({ "auth.json": "{}", "models.json": "{}" });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", {});
      assert.equal(res.ok, true);
      assert.equal(res.results.length, 9);
      assert.ok(res.results.every((r) => r.status === "no-credential"), "应全部是 no-credential");
      assert.equal(fetchCalls.length, 0, "没有凭据就不该发请求");
    } finally {
      restore();
    }
  });

  await testAsync("有凭据时只请求官方端点，key 只出现在 Authorization 头", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({ deepseek: { type: "api_key", key: "sk-test-key" } }),
      "models.json": "{}",
    });
    fetchResponses.set("https://api.deepseek.com/user/balance", {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.5" }] }),
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });
      assert.equal(res.ok, true);
      assert.equal(res.results.length, 1);
      assert.equal(res.results[0].status, "ready");
      assert.equal(res.results[0].report.metrics.find((m) => m.id === "cny-total").value, "42.5");

      assert.equal(fetchCalls.length, 1, "只应发一次请求");
      assert.equal(fetchCalls[0].url, "https://api.deepseek.com/user/balance");
      assert.equal(fetchCalls[0].headers.authorization, "Bearer sk-test-key");
      assert.ok(!JSON.stringify(fetchCalls[0].url).includes("sk-test"), "key 不得出现在 URL 里");
    } finally {
      restore();
    }
  });

  await testAsync("自定义 baseUrl 的供应商被拒绝，且不发请求", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": "{}",
      "models.json": JSON.stringify({
        providers: { deepseek: { apiKey: "sk-custom", baseUrl: "https://my-proxy.example.com/v1" } },
      }),
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });
      assert.equal(res.ok, true);
      assert.equal(res.results[0].status, "custom-origin");
      assert.equal(fetchCalls.length, 0, "自定义 origin 绝不能发请求");
    } finally {
      restore();
    }
  });

  await testAsync("一家失败不影响其他家（并发查询的隔离性）", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({
        deepseek: { type: "api_key", key: "sk-a" },
        openrouter: { type: "api_key", key: "sk-b" },
      }),
      "models.json": "{}",
    });
    fetchResponses.set("https://api.deepseek.com/user/balance", {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }),
    });
    // openrouter 走 429，带 Retry-After
    fetchResponses.set("https://openrouter.ai/api/v1/key", {
      status: 429,
      headers: { "retry-after": "60" },
      bodyText: "{}",
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek", "openrouter"] });
      const deepseek = res.results.find((r) => r.providerId === "deepseek");
      const openrouter = res.results.find((r) => r.providerId === "openrouter");
      assert.equal(deepseek.status, "ready", "成功的仍应成功");
      assert.equal(openrouter.status, "query-failed");
      assert.equal(openrouter.httpStatus, 429);
      assert.equal(openrouter.retryAfter, "60", "Retry-After 必须原样带回");
    } finally {
      restore();
    }
  });

  await testAsync("非 JSON 响应体判为 INVALID_JSON 而不是崩溃", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({ deepseek: { type: "api_key", key: "sk-a" } }),
      "models.json": "{}",
    });
    fetchResponses.set("https://api.deepseek.com/user/balance", {
      status: 200,
      headers: {},
      bodyText: "<html>not json</html>",
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });
      assert.equal(res.results[0].status, "query-failed");
      assert.equal(res.results[0].message, "INVALID_JSON");
    } finally {
      restore();
    }
  });

  await testAsync("net.fetch 抛错（如域名不在白名单）被兜成 query-failed", async () => {
    installFakeHost();
    globalThis.pi.net.fetch = async (input) => {
      fetchCalls.push(input);
      throw new Error("EGRESS_DENIED: domain not declared");
    };
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({ deepseek: { type: "api_key", key: "sk-a" } }),
      "models.json": "{}",
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });
      assert.equal(res.results[0].status, "query-failed");
      assert.match(res.results[0].message, /EGRESS_DENIED/);
    } finally {
      restore();
    }
  });

  await testAsync("缓存快照里不含任何凭据", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({ deepseek: { type: "api_key", key: "sk-super-secret" } }),
      "models.json": "{}",
    });
    fetchResponses.set("https://api.deepseek.com/user/balance", {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "9.99" }] }),
    });
    try {
      await main.onLoad();
      await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });

      const cached = await main.onPanelInvoke("balance.cached", {});
      const serialized = JSON.stringify(cached);
      assert.ok(!serialized.includes("sk-super-secret"), "缓存里绝不能出现 key");
      assert.ok(!serialized.includes("apiKey"), "缓存里不该有 apiKey 字段");
      assert.ok(serialized.includes("9.99"), "余额本身应在缓存里");
    } finally {
      restore();
    }
  });

  await testAsync("本机已配置但不在支持列表的供应商被盘点出来", async () => {
    installFakeHost();
    const restore = stubCredentialFiles({
      "auth.json": JSON.stringify({ apigoto: { type: "api_key", key: "sk-gw" } }),
      "models.json": JSON.stringify({
        providers: {
          longcat: { apiKey: "ak-1", baseUrl: "https://api.longcat.chat/openai/v1" },
          deepseek: { apiKey: "sk-real", baseUrl: "https://api.deepseek.com/v1" },
        },
      }),
    });
    try {
      await main.onLoad();
      const res = await main.onPanelInvoke("balance.refresh", { providers: ["deepseek"] });
      assert.deepEqual(
        res.unsupported.map((u) => u.id),
        ["apigoto", "longcat"],
        "只盘点不在九家支持列表里的供应商；deepseek 在列表内，不该出现在这里",
      );
      assert.equal(res.unsupported[0].reason, "NO_OFFICIAL_USAGE_ENDPOINT");
      // 盘点结果里不能带凭据
      assert.ok(!JSON.stringify(res.unsupported).includes("sk-gw"));
      assert.ok(!JSON.stringify(res.unsupported).includes("ak-1"));
    } finally {
      restore();
    }
  });

  await testAsync("未知通道返回 UNKNOWN_CHANNEL", async () => {
    installFakeHost();
    const unknown = await main.onPanelInvoke("nope.nope", {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, "UNKNOWN_CHANNEL");
  });

  await testAsync("外观读取走宿主 API", async () => {
    installFakeHost();
    const appearance = await main.onPanelInvoke("balance.appearance", {});
    assert.equal(appearance.ok, true);
    assert.equal(appearance.base, "dark");
    assert.equal(appearance.locale, "zh-CN");
  });

  await testAsync("app.getAppearance 不可用时退回 system", async () => {
    installFakeHost();
    globalThis.pi.app.getAppearance = async () => {
      throw new Error("UNSUPPORTED");
    };
    const appearance = await main.onPanelInvoke("balance.appearance", {});
    assert.equal(appearance.ok, true);
    assert.equal(appearance.base, "system");
    assert.equal(appearance.source, "fallback");
  });

  await main.onUnload();

  /* ------------------------------------------------------------ 汇总 */

  console.log("");
  if (failures.length) {
    console.log("失败 " + failures.length + " 项，通过 " + passed + " 项");
    for (const f of failures) {
      console.log("  - " + f.name);
      if (f.error && f.error.stack) console.log("    " + f.error.stack.split("\n").slice(1, 3).join("\n    "));
    }
    process.exit(1);
  }
  console.log("全部通过：" + passed + " 项");
})();
