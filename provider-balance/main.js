/*
 * provider-balance —— 插件进程入口。
 *
 * 职责：把视图的 onPanelInvoke 通道分发到 lib/usage.js 的查询引擎上，
 * 并缓存最近一次结果（只缓存在插件设置里，供视图首屏秒开）。
 *
 * 借鉴来源：pi-agent-desktop（github.com/abcwyc/pi-agent-desktop）的
 * lib/provider-usage.ts + lib/provider-usage-ids.ts + app/api/provider-usage/query。
 * 那是一个 Electron + Next.js 桌面应用，在服务端用 pi 的 ModelRuntime 解析
 * 凭据并直连九家供应商的余额端点；PI-Desktop 完全没有这个能力
 * （apps/desktop/src 全库无 balance/credit 相关实现，官方 usage-dashboard
 * 插件只统计本地 token 计数），所以这是一块真实空白。
 *
 * 凭据从哪来：插件进程拿不到宿主的凭据网关（spec 07-plugins §3 明确
 * 「No secrets」，pi.models.list 也只返回已登录模型而不给 key）。所以这里
 * 直接读 pi 的 agent 目录下的 auth.json 与 models.json —— PI-Desktop 自己
 * 也是这么定位凭据的（packages/agent-runtime/src/native-pi-session.ts:310）。
 * 这是本机 pi.token-insights / local.token-meter / local.trajectory 已采用的
 * 同一取舍：读本地文件走进程内原生 Node fs，对宿主严格只读。
 *
 * 安全边界（写进 manifest 的 safetyNotes，也写进 README）：
 *   - 只读 auth.json / models.json 取凭据，不写回、不上报、不落盘。
 *   - 请求只发往供应商官方 origin；自定义 baseUrl 的供应商直接拒绝，
 *     避免把 API key 发到第三方域名（lib/usage.js isOfficialOrigin）。
 *   - 请求走宿主的 pi.net.fetch（受 manifest.net.domains 白名单约束），
 *     而不是原生 fetch：让宿主来做出口管控与审计。
 *   - 缓存的报告里不含任何 key、token 或账号标识。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const usage = require("./lib/usage.js");

/** 插件设置里存最近一次报告的键，与视图侧保持一致。 */
const KEY_SNAPSHOT = "lastReport";

/** 单次请求超时，与上游 fetchJson 的 15s 一致。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 响应体上限，与上游 fetchJson 的 64 KiB 一致。 */
const MAX_BODY_BYTES = 65_536;

/** 缓存有效期：超过这个时间的报告在视图里标注为陈旧。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** pi 的 agent 目录，与宿主 native-pi-session.ts:310 同一约定。 */
let agentDir = null;
let unloaded = false;

/* ------------------------------------------------------------ 目录与读取 */

function resolveAgentDir() {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".pi", "agent");
}

/** 读 JSON 文件，任何失败都返回 null（缺文件是正常情况，不是错误）。 */
function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 某个供应商是否在 models.json 里配置了自定义 baseUrl。 */
function customBaseUrlOf(providerId, models) {
  const providers = models && typeof models === "object" ? models.providers : null;
  const entry = providers && typeof providers === "object" ? providers[providerId] : null;
  const baseUrl = entry && typeof entry === "object" ? entry.baseUrl : null;
  return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
}

/* ------------------------------------------------------------------ 查询 */

/**
 * 查询一个供应商。
 *
 * 返回统一形状，永不抛错——一个供应商失败不该让整批结果消失：
 *   { providerId, providerName, status, ... }
 *   status: "ready" | "no-credential" | "custom-origin" | "auth-failed"
 *         | "query-failed" | "empty" | "unsupported"
 */
async function queryOne(providerId, { auth, models, force }) {
  const providerName = usage.PROVIDER_NAMES[providerId] || providerId;

  if (!usage.isProviderId(providerId)) {
    return { providerId, providerName, status: "unsupported" };
  }

  const credential = usage.resolveCredential(providerId, { auth, models });
  if (!credential.ok) {
    return { providerId, providerName, status: "no-credential" };
  }

  // 自定义 origin 拒绝查询：把 key 发给非官方域名等于泄露凭据。
  const baseUrl = credential.baseUrl || customBaseUrlOf(providerId, models);
  if (baseUrl && !usage.isOfficialOrigin(providerId, baseUrl)) {
    return { providerId, providerName, status: "custom-origin", baseUrl };
  }

  const endpoint = usage.resolveEndpoint(providerId, credential.apiKey);

  let response;
  try {
    response = await pi.net.fetch({
      url: endpoint,
      method: "GET",
      headers: { authorization: `Bearer ${credential.apiKey}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      providerId,
      providerName,
      status: "query-failed",
      message: error && error.message ? String(error.message) : String(error),
    };
  }

  if (response.status < 200 || response.status >= 300) {
    // 429 的 Retry-After 是宿主唯一给出的退避信号，原样带回给用户看。
    const retryAfter = response.headers && (response.headers["retry-after"] || response.headers["Retry-After"]);
    return {
      providerId,
      providerName,
      status: "query-failed",
      httpStatus: response.status,
      ...(retryAfter ? { retryAfter: String(retryAfter) } : {}),
    };
  }

  const bodyText = typeof response.bodyText === "string" ? response.bodyText : "";
  if (bodyText.length > MAX_BODY_BYTES) {
    return { providerId, providerName, status: "query-failed", message: "RESPONSE_TOO_LARGE" };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { providerId, providerName, status: "query-failed", message: "INVALID_JSON" };
  }

  const normalized = usage.normalizePayload(providerId, payload, Date.now());
  if (!normalized.ok) {
    return { providerId, providerName, status: "empty", reason: normalized.reason };
  }
  return { providerId, providerName, status: "ready", report: normalized.report };
}

/**
 * 查询全部（或指定）供应商。
 *
 * 并发查询：九个端点各 15s 超时，串行最坏要等两分多钟。并发下最坏
 * 只等一个超时。
 */
async function queryAll(requested) {
  const auth = readJsonFile(path.join(agentDir, "auth.json")) || {};
  const models = readJsonFile(path.join(agentDir, "models.json")) || {};

  const ids = Array.isArray(requested) && requested.length
    ? requested.filter((id) => usage.isProviderId(id))
    : usage.PROVIDER_IDS.slice();

  const results = await Promise.all(ids.map((id) => queryOne(id, { auth, models })));
  return {
    ok: true,
    capturedAt: Date.now(),
    results,
    // 本机配了、但这九家端点覆盖不到的供应商。没有这一段时，用户看到的只是
    // 九行「未登录」，却不知道自己真正在用的聚合网关本来就不在支持列表里。
    unsupported: listConfiguredButUnsupported(auth, models),
  };
}

/**
 * 盘点「本机已配置但不在支持列表」的供应商。
 *
 * 只回报名字与原因，不回传 key 或 baseUrl 的完整值——视图只需要让用户
 * 看懂为什么这里没有他的供应商。
 */
function listConfiguredButUnsupported(auth, models) {
  const names = new Set();
  for (const source of [auth, models && models.providers]) {
    if (!source || typeof source !== "object") continue;
    for (const id of Object.keys(source)) {
      if (!usage.isProviderId(id)) names.add(id);
    }
  }
  return Array.from(names).sort().map((id) => ({ id, reason: "NO_OFFICIAL_USAGE_ENDPOINT" }));
}

/* ------------------------------------------------------------------ 缓存 */

/** 读缓存快照；读失败当成没有缓存，绝不让读异常挡住视图。 */
async function readSnapshot() {
  let settings = null;
  try {
    settings = await pi.plugin.getSettings();
  } catch {
    settings = null;
  }
  const stored = settings && settings[KEY_SNAPSHOT];
  if (!stored || typeof stored !== "object") return null;
  return stored;
}

/** 写缓存快照。失败不抛：缓存是加速手段，不是数据源。 */
async function writeSnapshot(snapshot) {
  try {
    await pi.plugin.setSettings({ [KEY_SNAPSHOT]: snapshot });
  } catch {
    /* 缓存写失败不影响本次返回 */
  }
}

/* --------------------------------------------------------------- 生命周期 */

async function onLoad() {
  unloaded = false;
  agentDir = resolveAgentDir();

  await pi.commands.register({
    id: "providerBalance.refresh",
    title: "余额看板：刷新全部供应商",
    keywords: ["balance", "quota", "usage", "credit", "余额", "配额", "额度", "刷新"],
    category: "Data",
    run: async () => {
      const snapshot = await queryAll(null);
      await writeSnapshot(snapshot);
      const ready = snapshot.results.filter((r) => r.status === "ready").length;
      const total = snapshot.results.length;
      await pi.ui.showToast(`余额看板：${ready}/${total} 家查询成功`, ready ? "info" : "warn");
    },
  });
}

async function onUnload() {
  unloaded = true;
  try {
    await pi.commands.unregister("providerBalance.refresh");
  } catch {
    /* 已经没了 */
  }
}

/**
 * 面板桥把宿主不认识的通道原样转发到这里。
 *
 * 所有分支都返回 {ok, ...}；抛错也兜成 {ok:false, error}，
 * 视图侧永远拿到可判定的形状（沿用 local.trajectory 的范式）。
 */
async function onPanelInvoke(channel, payload) {
  try {
    switch (channel) {
      case "balance.cached":
        return { ok: true, snapshot: await readSnapshot(), ttlMs: CACHE_TTL_MS };

      case "balance.refresh": {
        if (unloaded) return { ok: false, error: "UNLOADED" };
        const requested = payload && Array.isArray(payload.providers) ? payload.providers : null;
        const snapshot = await queryAll(requested);
        await writeSnapshot(snapshot);
        return snapshot;
      }

      case "balance.appearance":
        return { ok: true, ...(await readAppearance()) };

      default:
        return { ok: false, error: "UNKNOWN_CHANNEL" };
    }
  } catch (error) {
    return { ok: false, error: error && error.message ? String(error.message) : String(error) };
  }
}

/**
 * 外观（明暗/语言）。
 *
 * 先问宿主的 app.getAppearance；老宿主会以 UNSUPPORTED 拒绝，此时退回
 * system。不读 pi.sqlite 去猜主题——那是 local.trajectory 为兼容旧宿主
 * 才做的额外路径，这里没必要复制。
 */
async function readAppearance() {
  try {
    const value = await pi.app.getAppearance();
    const base = value && (value.base === "light" || value.base === "dark") ? value.base : "system";
    const locale = value && typeof value.locale === "string" && value.locale ? value.locale : null;
    return { base, locale, source: "api" };
  } catch {
    return { base: "system", locale: null, source: "fallback" };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
