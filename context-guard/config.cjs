"use strict";

const DEFAULTS = Object.freeze({
  enabled: false, compressionMode: "system", rescueOnLimit: true,
  sourceProvider: "", sourceModelId: "", sourceApi: "openai-responses",
  compressionProvider: "", compressionModelId: "", threshold: 90,
});
const KEYS = Object.keys(DEFAULTS);
const TEXT_KEYS = ["sourceProvider", "sourceModelId", "sourceApi", "compressionProvider", "compressionModelId"];
function normalize(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    enabled: value.enabled === true,
    compressionMode: value.compressionMode === "dedicated" ? "dedicated" : "system",
    rescueOnLimit: value.rescueOnLimit !== false,
    ...Object.fromEntries(TEXT_KEYS.map(key => [key, typeof value[key] === "string" ? value[key].trim().slice(0, 256) : DEFAULTS[key]])),
    threshold: Number.isInteger(value.threshold) && value.threshold >= 2 && value.threshold <= 98 ? value.threshold : DEFAULTS.threshold,
  };
}
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("配置必须是对象。");
  for (const key of Object.keys(input)) if (!KEYS.includes(key)) throw new Error(`不支持的配置项：${key}`);
  if (typeof input.enabled !== "boolean") throw new Error("启用状态必须是布尔值。");
  if (input.compressionMode !== undefined && !["system", "dedicated"].includes(input.compressionMode)) throw new Error("请选择系统压缩或独立摘要模型。");
  if (input.rescueOnLimit !== undefined && typeof input.rescueOnLimit !== "boolean") throw new Error("上限恢复开关必须是布尔值。");
  for (const key of TEXT_KEYS) if (typeof input[key] !== "string" || input[key].trim().length > 256) throw new Error(`配置项 ${key} 无效。`);
  if (!Number.isInteger(input.threshold) || input.threshold < 2 || input.threshold > 98) throw new Error("触发轮次须为 2–98 的整数。");
  const settings = normalize(input);
  if (settings.enabled && settings.compressionMode === "dedicated" && ![settings.sourceProvider, settings.sourceModelId, settings.sourceApi, settings.compressionProvider, settings.compressionModelId].every(Boolean)) throw new Error("独立摘要模式需要完整选择主模型、协议和压缩模型。");
  if (settings.enabled && Boolean(settings.sourceProvider) !== Boolean(settings.sourceModelId)) throw new Error("主模型供应商和完整模型 ID 必须同时填写或同时留空。");
  if (settings.enabled && settings.sourceProvider && !settings.sourceApi) throw new Error("筛选主模型时请填写实际协议标识。");
  return settings;
}
function matches(model, settings) {
  return Boolean(settings.enabled && model && settings.sourceProvider && settings.sourceModelId && settings.sourceApi
    && model.provider === settings.sourceProvider && model.id === settings.sourceModelId && model.api === settings.sourceApi);
}
function systemMatches(model, settings) {
  return settings.enabled && settings.compressionMode === "system" && (!settings.sourceProvider && !settings.sourceModelId || matches(model, settings));
}
function signature(settings) { return JSON.stringify(normalize(settings)); }
module.exports = { DEFAULTS, KEYS, normalize, validate, matches, systemMatches, signature };
