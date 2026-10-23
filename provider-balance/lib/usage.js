/*
 * provider-balance / lib/usage.js
 *
 * 供应商余额与配额查询引擎：端点表、凭据解析、响应归一化。
 *
 * 来源：移植自 pi-agent-desktop 的 lib/provider-usage.ts（MIT）与
 * lib/provider-usage-ids.ts。原实现在 Next.js 服务端用 ModelRuntime 解析
 * 凭据；PI-Desktop 插件进程拿不到宿主的凭据网关（spec 07-plugins 明确
 * 「No secrets」），所以这里改成直接读 pi 的 agent 目录（~/.pi/agent 的
 * auth.json 与 models.json）——PI-Desktop 自己也是这么找凭据的
 * （packages/agent-runtime/src/native-pi-session.ts:310 把 agentDir 定为
 * join(homedir(), ".pi", "agent")）。
 *
 * 三处刻意的行为差异（相对上游），都写进了 README：
 *   1. 归一化不抛错，改成返回 {ok:false, reason}。上游在服务端抛异常由
 *      路由兜成 query-failed；插件里抛错会打断整批查询，一个供应商失败
 *      不该让其他供应商的结果消失。
 *   2. 增加「官方 origin 校验」的显式开关：自定义 baseUrl 的供应商（本机
 *      models.json 里的 longcat / a1888 / apigoto 都是）会被拒绝查询，
 *      因为把 API key 发到一个非官方域名上是不该做的事。
 *   3. 归一化后的数值一律保留原始字符串精度（decimal），不用浮点。
 */

"use strict";

/* ------------------------------------------------------------------ 常量表 */

/**
 * 支持的供应商及其余额/配额端点。
 *
 * 端点与上游 lib/provider-usage.ts:53-63 逐条一致。这些 URL 同时要写进
 * manifest.json 的 net.domains，否则宿主的 egress 网关会在发出请求前拒绝。
 */
const ENDPOINTS = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
  openrouter: "https://openrouter.ai/api/v1/key",
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  "moonshotai-cn": "https://api.moonshot.cn/v1/users/me/balance",
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/credits",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
};

/** 展示名，与上游 PROVIDER_NAMES 一致。 */
const PROVIDER_NAMES = {
  "openai-codex": "OpenAI Codex",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
};

/** 余额币种：人民币区与美元区各两个。 */
const CURRENCY = {
  moonshotai: "USD",
  "moonshotai-cn": "CNY",
  minimax: "USD",
  "minimax-cn": "CNY",
};

/** pi 的 agent 目录名，与宿主 native-pi-session.ts:310 保持同一约定。 */
const PROVIDER_IDS = Object.keys(ENDPOINTS);

function isProviderId(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ENDPOINTS, value);
}

/* ------------------------------------------------------------ 基础取值工具 */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value) {
  return isRecord(value) ? value : undefined;
}

/** 压成一行、去控制字符、限长 80。上游同名函数。 */
function stringValue(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80);
  return cleaned || undefined;
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function nonnegative(value) {
  const result = number(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

function nonnegativeInteger(value) {
  const result = nonnegative(value);
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
}

/**
 * 金额：保留原字符串，不做浮点往返。
 *
 * 上游返回 string 就是为了不丢精度（decimal 函数）；这里沿用，
 * 视图侧只在展示时才做 Number() 转换。
 */
function decimal(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 64) return value;
  return undefined;
}

function epochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value >= 1_000_000_000_000 ? value / 1_000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : undefined;
}

function clamp(value) {
  return Math.min(100, Math.max(0, value));
}

/* ------------------------------------------------------------ 端点与来源校验 */

/**
 * 只允许官方 origin 查询。
 *
 * 为什么必须做：本机 models.json 里长期存在自定义供应商（longcat、
 * a1888、apigoto 等），它们的 baseUrl 指向第三方。把 API key 发给一个
 * 非官方域名等于泄露凭据，所以自定义 origin 一律拒绝，并把原因回报给用户。
 */
function isOfficialOrigin(providerId, baseUrl) {
  if (!isProviderId(providerId) || !baseUrl) return false;
  try {
    return new URL(baseUrl).origin === new URL(ENDPOINTS[providerId]).origin;
  } catch {
    return false;
  }
}

/** MiniMax 两个端点按 token 前缀分流，上游 fetchJson 的同名逻辑。 */
function resolveEndpoint(providerId, token) {
  let endpoint = ENDPOINTS[providerId];
  if (providerId === "minimax" || providerId === "minimax-cn") {
    endpoint += token && token.startsWith("sk-api-") ? "/account/query_balance" : "/v1/token_plan/remains";
  }
  return endpoint;
}

/* ------------------------------------------------------------------ 归一化 */

/** 把秒数窗口渲染成人读标签，上游 windowLabel 的同名逻辑。 */
function windowLabel(seconds) {
  if (!seconds || seconds <= 0) return "Limit";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 10_080) return "Weekly";
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function normalizeCodex(payload, capturedAt) {
  const buckets = [];
  const addGroup = (group, groupLabel, groupId) => {
    for (const [position, raw] of [["primary", group.primary_window], ["secondary", group.secondary_window]]) {
      const window = record(raw);
      const used = number(window?.used_percent);
      if (used === undefined) continue;
      const seconds = number(window?.limit_window_seconds);
      const resetAt = number(window?.reset_at);
      buckets.push({
        id: `${groupId}:${position}`,
        label: windowLabel(seconds),
        ...(groupId === "codex" ? {} : { groupLabel }),
        used: clamp(used),
        remaining: 100 - clamp(used),
        limit: 100,
        unit: "percent",
        ...(seconds && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
        ...(resetAt !== undefined ? { resetsAt: resetAt } : {}),
      });
    }
  };
  const rateLimit = record(payload.rate_limit);
  if (rateLimit) addGroup(rateLimit, "Codex", "codex");
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  additional.forEach((item, index) => {
    const value = record(item);
    const rate = record(value?.rate_limit);
    if (rate) {
      addGroup(
        rate,
        stringValue(value?.limit_name) ?? `Limit ${index + 1}`,
        stringValue(value?.metered_feature) ?? `additional-${index}`,
      );
    }
  });

  const metrics = [];
  const credits = record(payload.credits);
  if (credits?.unlimited === true) metrics.push({ id: "credits", label: "Credits", value: "Unlimited" });
  else if (number(credits?.balance) !== undefined) {
    metrics.push({ id: "credits", label: "Credits", value: number(credits.balance), unit: "count" });
  }
  if (!buckets.length && !metrics.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId: "openai-codex", providerName: PROVIDER_NAMES["openai-codex"], capturedAt, buckets, metrics } };
}

function normalizeDeepSeek(payload, capturedAt) {
  const metrics = [
    { id: "availability", label: "API calls", value: payload.is_available === true ? "Available" : "Unavailable" },
  ];
  const rows = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  for (const row of rows) {
    const value = record(row);
    const currency = value?.currency === "CNY" || value?.currency === "USD" ? value.currency : undefined;
    if (!currency) continue;
    for (const [id, label, field] of [
      ["total", "Total balance", "total_balance"],
      ["granted", "Granted balance", "granted_balance"],
      ["topped-up", "Topped-up balance", "topped_up_balance"],
    ]) {
      const amount = decimal(value?.[field]);
      if (amount !== undefined) {
        metrics.push({ id: `${currency.toLowerCase()}-${id}`, label, value: amount, unit: "currency", currency });
      }
    }
  }
  if (rows.length === 0) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId: "deepseek", providerName: PROVIDER_NAMES.deepseek, capturedAt, buckets: [], metrics } };
}

function normalizeOpenRouter(payload, capturedAt) {
  const data = record(payload.data);
  if (!data) return { ok: false, reason: "EMPTY_PAYLOAD" };
  const buckets = [];
  const limit = nonnegative(data.limit);
  const remaining = nonnegative(data.limit_remaining);
  if (limit !== undefined) {
    buckets.push({
      id: "key-limit",
      label: "Key limit",
      limit,
      ...(remaining !== undefined ? { remaining, used: Math.max(0, limit - remaining) } : {}),
      unit: "currency",
      currency: "USD",
      ...(stringValue(data.limit_reset) ? { period: stringValue(data.limit_reset) } : {}),
    });
  }
  const metrics = [];
  for (const [id, label, field] of [
    ["daily", "Usage today", "usage_daily"],
    ["weekly", "Usage this week", "usage_weekly"],
    ["monthly", "Usage this month", "usage_monthly"],
    ["total", "All-time usage", "usage"],
  ]) {
    const amount = nonnegative(data[field]);
    if (amount !== undefined) metrics.push({ id, label, value: amount, unit: "currency", currency: "USD" });
  }
  if (!buckets.length && !metrics.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId: "openrouter", providerName: PROVIDER_NAMES.openrouter, capturedAt, buckets, metrics } };
}

function normalizeVercel(payload, capturedAt) {
  const balance = decimal(payload.balance);
  const used = decimal(payload.total_used);
  if (balance === undefined && used === undefined) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return {
    ok: true,
    report: {
      providerId: "vercel-ai-gateway",
      providerName: PROVIDER_NAMES["vercel-ai-gateway"],
      capturedAt,
      buckets: [],
      metrics: [
        ...(balance !== undefined ? [{ id: "balance", label: "Credit balance", value: balance, unit: "currency", currency: "USD" }] : []),
        ...(used !== undefined ? [{ id: "spent", label: "Lifetime spend", value: used, unit: "currency", currency: "USD" }] : []),
      ],
    },
  };
}

function normalizeMoonshot(providerId, payload, capturedAt) {
  const data = record(payload.data);
  if (payload.code !== 0 || payload.status !== true || !data) return { ok: false, reason: "UNSUCCESSFUL_RESPONSE" };
  const metrics = [
    ["available", "Available balance", data.available_balance],
    ["voucher", "Voucher balance", data.voucher_balance],
    ["cash", "Cash balance", data.cash_balance],
  ]
    .map(([id, label, value]) => {
      const amount = number(value);
      if (amount === undefined) return null;
      return { id: String(id), label: String(label), value: String(amount), unit: "currency", currency: CURRENCY[providerId] };
    })
    .filter(Boolean);
  if (!metrics.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets: [], metrics } };
}

function normalizeMiniMax(providerId, payload, capturedAt) {
  const base = record(payload.base_resp);
  if (base && base.status_code !== 0) return { ok: false, reason: "UNSUCCESSFUL_RESPONSE" };

  if (Array.isArray(payload.model_remains)) {
    const buckets = [];
    payload.model_remains.forEach((rowValue, index) => {
      const row = record(rowValue);
      if (!row) return;
      const groupLabel = stringValue(row.model_name) ?? `Quota ${index + 1}`;
      addMiniMaxWindow(buckets, row, groupLabel, "interval");
      addMiniMaxWindow(buckets, row, groupLabel, "weekly");
    });
    if (!buckets.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
    return { ok: true, report: { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets, metrics: [] } };
  }

  const metrics = [
    ["available", "Available balance", payload.available_amount],
    ["cash", "Cash balance", payload.cash_balance],
    ["voucher", "Voucher balance", payload.voucher_balance],
    ["credit", "Credit balance", payload.credit_balance],
  ]
    .map(([id, label, value]) => {
      const amount = decimal(value);
      if (amount === undefined) return null;
      return { id: String(id), label: String(label), value: amount, unit: "currency", currency: CURRENCY[providerId] };
    })
    .filter(Boolean);
  if (!metrics.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets: [], metrics } };
}

/**
 * MiniMax 的一个时间窗。
 *
 * status === 3 表示「不限量」；否则优先用 count/total，没有计数时退回百分比。
 * 上游用「哪种解释更接近上报的 remaining percent」来判定 remaining 该取
 * count 还是 total - count，这里保留该判定。
 */
function addMiniMaxWindow(buckets, row, groupLabel, suffix) {
  const isInterval = suffix === "interval";
  const status = number(row[isInterval ? "current_interval_status" : "current_weekly_status"]);
  const end = number(row[isInterval ? "end_time" : "weekly_end_time"]);
  const start = number(row[isInterval ? "start_time" : "weekly_start_time"]);
  const percent = nonnegative(row[isInterval ? "current_interval_remaining_percent" : "current_weekly_remaining_percent"]);
  const label = isInterval ? "Rolling" : "Weekly";

  if (status === 3) {
    buckets.push({ id: `${groupLabel}:${suffix}`, label, groupLabel, remaining: 100, unit: "percent", period: "Unlimited" });
    return;
  }
  const total = nonnegativeInteger(row[isInterval ? "current_interval_total_count" : "current_weekly_total_count"]);
  const count = nonnegativeInteger(row[isInterval ? "current_interval_usage_count" : "current_weekly_usage_count"]);
  if (total === undefined && percent === undefined) return;

  const windowMinutes = end !== undefined && start !== undefined ? Math.max(1, Math.round((end - start) / 60_000)) : undefined;
  const resetsAt = end !== undefined ? Math.floor(end / 1_000) : undefined;

  if (total && count !== undefined) {
    let remaining = count;
    if (percent !== undefined) {
      const asRemaining = (count / total) * 100;
      const asUsed = ((total - count) / total) * 100;
      if (Math.abs(asUsed - percent) < Math.abs(asRemaining - percent)) remaining = total - count;
    }
    buckets.push({
      id: `${groupLabel}:${suffix}`,
      label,
      groupLabel,
      used: total - remaining,
      remaining,
      limit: total,
      unit: "count",
      ...(windowMinutes ? { windowMinutes } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
    return;
  }
  buckets.push({
    id: `${groupLabel}:${suffix}`,
    label,
    groupLabel,
    used: 100 - clamp(percent),
    remaining: clamp(percent),
    limit: 100,
    unit: "percent",
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  });
}

function normalizeOpenCodeGo(payload, capturedAt) {
  const usage = record(payload.usage) ?? payload;
  const labels = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };
  const buckets = [];
  for (const [id, raw] of Object.entries(usage)) {
    const window = record(raw);
    if (!window) continue;
    const percent = nonnegative(window.percent ?? window.usagePercent ?? window.usage_percent);
    if (percent === undefined) continue;
    const resetsAt = epochSeconds(window.resetsAt ?? window.resetAt ?? window.resets_at ?? window.reset_at);
    buckets.push({
      id,
      label: labels[id] ?? id,
      used: clamp(percent),
      remaining: 100 - clamp(percent),
      limit: 100,
      unit: "percent",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (!buckets.length) return { ok: false, reason: "EMPTY_PAYLOAD" };
  return { ok: true, report: { providerId: "opencode-go", providerName: PROVIDER_NAMES["opencode-go"], capturedAt, buckets, metrics: [] } };
}

/**
 * 归一化入口。
 *
 * 与上游的差异：不抛错，返回 {ok:false, reason}，让调用方决定怎么呈现。
 * 原因见文件头。
 */
function normalizePayload(providerId, payload, capturedAt = Date.now()) {
  if (!isProviderId(providerId)) return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  const body = record(payload);
  if (!body) return { ok: false, reason: "NOT_AN_OBJECT" };
  switch (providerId) {
    case "openai-codex":
      return normalizeCodex(body, capturedAt);
    case "deepseek":
      return normalizeDeepSeek(body, capturedAt);
    case "openrouter":
      return normalizeOpenRouter(body, capturedAt);
    case "vercel-ai-gateway":
      return normalizeVercel(body, capturedAt);
    case "moonshotai":
    case "moonshotai-cn":
      return normalizeMoonshot(providerId, body, capturedAt);
    case "minimax":
    case "minimax-cn":
      return normalizeMiniMax(providerId, body, capturedAt);
    case "opencode-go":
      return normalizeOpenCodeGo(body, capturedAt);
    default:
      return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }
}

/* ------------------------------------------------------------ 凭据解析 */

/**
 * 从 pi 的 auth.json + models.json 里解析某个供应商的凭据。
 *
 * 返回 { ok:true, apiKey, baseUrl, source } 或 { ok:false, reason }。
 *
 * 解析顺序（与 pi 自己的解析一致：auth.json 是显式登录，models.json 是
 * 自定义供应商配置）：
 *   1. auth.json[providerId] 是 { type:"api_key", key } → 用它
 *   2. auth.json[providerId] 是 OAuth（含 access/refresh）→ 用 access token
 *   3. models.json.providers[providerId] → apiKey + baseUrl
 *
 * 只读，不写回，不缓存到磁盘。
 */
function resolveCredential(providerId, { auth, models } = {}) {
  if (!isProviderId(providerId)) return { ok: false, reason: "UNSUPPORTED_PROVIDER" };

  const authEntry = record(auth) ? record(auth)[providerId] : undefined;
  if (isRecord(authEntry)) {
    const key = stringValue(authEntry.key);
    if (key && authEntry.type !== "oauth") return { ok: true, apiKey: key, source: "auth.json" };
    const access = stringValue(authEntry.access);
    if (access) return { ok: true, apiKey: access, source: "auth.json(oauth)" };
  }

  const providerEntry = record(record(models)?.providers) ? record(models).providers[providerId] : undefined;
  if (isRecord(providerEntry)) {
    const key = stringValue(providerEntry.apiKey);
    const baseUrl = stringValue(providerEntry.baseUrl);
    if (key) return { ok: true, apiKey: key, baseUrl, source: "models.json" };
  }

  return { ok: false, reason: "NO_CREDENTIAL" };
}

module.exports = {
  ENDPOINTS,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  CURRENCY,
  isProviderId,
  isOfficialOrigin,
  resolveEndpoint,
  normalizePayload,
  resolveCredential,
  // 单独导出便于单测逐条覆盖
  normalizeCodex,
  normalizeDeepSeek,
  normalizeOpenRouter,
  normalizeVercel,
  normalizeMoonshot,
  normalizeMiniMax,
  normalizeOpenCodeGo,
  windowLabel,
};
