/**
 * Loop Brake —— 重复工具调用闸的纯逻辑层。
 *
 * 这一层不碰 ExtensionAPI、不碰网络与文件，也没有隐藏时钟依赖，
 * 因此可以在 Node 里直接单测，不需要起 agent。
 *
 * 设计对应 opencode 的 `doom_loop` 权限键："the same tool call repeats
 * 3 times with identical input"。比它多两件事：
 *   1. 连续重复才计数 —— 中间夹一次别的调用就清零，避免把「分页读取」
 *      这类夹杂其他动作的序列误判成死循环。
 *   2. 可配的「先警告后阻断」 —— 第一次撞线只提醒、不拦，第二次才阻断，
 *      给模型一次自我纠正的机会。
 */

/** 命中次数达到这个值就不再累积（防止内存无谓增长）。 */
const COUNT_CEILING = 1000;

/** toolName 的长度上限；超长的名字一律截断，避免异常输入撑爆指纹。 */
const MAX_TOOL_NAME = 120;

/** 单个字符串值参与指纹计算时的头部截断长度。 */
const MAX_STRING = 2048;

/** 超长字符串追加的尾部摘要长度，用于区分「头部相同、尾部不同」。 */
const MAX_STRING_TAIL = 64;

/** 指纹里最多保留多少个键（超出按排序后截断，并打标记）。 */
const MAX_KEYS = 64;

/** 数组参与指纹时最多保留多少个元素。 */
const MAX_ARRAY = 200;

/** 默认设置。调用方可以在插件设置里覆盖其中任意一项。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  threshold: 3,
  /** "warn" = 第一次撞线只警告；"block" = 第一次撞线就阻断。 */
  mode: "warn",
  /** 观察名单：这些工具即使撞线也永不止损（例如合法的轮询）。 */
  ignoreTools: [],
});

/**
 * 把任意入参规范成稳定指纹。
 *
 * 归一化规则（每条都对应一类真实误判）：
 * - 对象键排序：模型每次生成的键顺序可能不同，但语义相同。
 * - 字符串截断 + 尾部摘要：避免超长内容撑爆内存。**只截断是不够的**——
 *   「前 2048 字符相同、尾部不同」的两次 Write，若只留长度标记且长度恰好
 *   相同，就会被误判为同一次。因此超长时追加「尾部 64 字符 + 总长度」，
 *   足以区分绝大多数真实差异，又不把全文留在内存里。
 * - 数字统一成字符串：`1` 与 `1.0` 等价。
 * - 过深嵌套与循环引用按深度截断，绝不抛错。
 *
 * 刻意**不**做的归一化：绝对路径、时间戳、UUID。这些看起来像「易变字段」，
 * 但剥掉它们就等于承认「不同目录的两次 Read 是同一次」——那会误杀合法调用。
 * 宁可漏判，不可误杀；漏判还有 warn 阶段兜底。
 */
function canonicalize(value, depth = 0) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;

  if (type === "string") {
    if (value.length <= MAX_STRING) return JSON.stringify(value);
    const tail = value.slice(-MAX_STRING_TAIL);
    return `${JSON.stringify(value.slice(0, MAX_STRING))}~(len:${value.length},tail:${JSON.stringify(tail)})`;
  }

  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  if (type === "function") return "[function]";
  if (type === "symbol") return "[symbol]";

  // 深度保护：过深的嵌套只保留层级标记，循环引用也会在这里被截断。
  if (depth >= 8) return `[depth:${depth}]`;

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((item) => canonicalize(item, depth + 1));
    return value.length > MAX_ARRAY
      ? `[${head.join(",")},~(len:${value.length})]`
      : `[${head.join(",")}]`;
  }

  if (type === "object") {
    const keys = Object.keys(value).sort();
    const kept = keys.slice(0, MAX_KEYS);
    const parts = kept.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`);
    const truncated = keys.length > MAX_KEYS ? `,~(keys:${keys.length})` : "";
    return `{${parts.join(",")}${truncated}}`;
  }

  return `[${type}]`;
}

/**
 * 由工具名与入参算出一次调用的身份。
 * `input === undefined`（没有入参的工具，如 todo_read）也是合法身份。
 */
function fingerprint(toolName, input) {
  const name = typeof toolName === "string" ? toolName.slice(0, MAX_TOOL_NAME) : String(toolName);
  return `${name}\u0000${canonicalize(input)}`;
}

/**
 * 把插件设置读成一份完整、可信的配置。
 * 任何字段缺失、类型不对、越界，都回落到默认值 —— 绝不让脏设置把闸门关掉
 * 或者让它变成永远不触发。唯一的例外是 `enabled: false`，那是用户显式关闸。
 */
function normalizeSettings(raw) {
  const settings = raw && typeof raw === "object" ? raw : {};

  const enabled = settings.enabled === false ? false : DEFAULTS.enabled;

  const rawThreshold = settings.threshold;
  const parsed = typeof rawThreshold === "number" ? rawThreshold : Number(rawThreshold);
  const threshold =
    Number.isFinite(parsed) && parsed >= 2 && parsed <= 20 ? Math.floor(parsed) : DEFAULTS.threshold;

  const mode = settings.mode === "block" ? "block" : DEFAULTS.mode;

  const ignoreTools = Array.isArray(settings.ignoreTools)
    ? settings.ignoreTools
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim())
    : [];

  return { enabled, threshold, mode, ignoreTools };
}

/** 一句话描述入参形状，让模型一眼看出「同在哪里」。不泄露大段内容。 */
function describe(input) {
  if (input === undefined || input === null) return "no arguments";
  if (Array.isArray(input)) return `an argument array of length ${input.length}`;
  if (typeof input !== "object") return `${typeof input} arguments`;
  const keys = Object.keys(input);
  if (keys.length === 0) return "empty arguments";
  const shown = keys.slice(0, 4).map((key) => shortValue(key, input[key]));
  return keys.length > 4 ? `arguments {${shown.join(", ")}, …}` : `arguments {${shown.join(", ")}}`;
}

/** 单个值的一行缩略。 */
function shortValue(key, value) {
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    const clipped = flat.length > 32 ? `${flat.slice(0, 32)}…` : flat;
    return `${key}=${JSON.stringify(clipped)}`;
  }
  if (Array.isArray(value)) return `${key}=[${value.length}]`;
  if (value && typeof value === "object") return `${key}={…}`;
  return `${key}=${String(value)}`;
}

/** 生成留给模型的首条警告。必须给出下一步动作，否则模型只会重试。 */
function warnReason({ displayName, threshold, input }) {
  const shaped = describe(input);
  return (
    `Detected ${threshold} consecutive identical calls to ${displayName} with ${shaped}. ` +
    `Repeating the exact same call will not change the result. ` +
    `Change the arguments, switch to a different tool, or report the blocker to the user instead of retrying.`
  );
}

/** 生成阻断原因。语气要硬，但仍给出路，避免模型卡死。 */
function blockReason({ displayName, threshold, input }) {
  const shaped = describe(input);
  return (
    `Blocked: ${threshold} identical back-to-back calls to ${displayName} with ${shaped}. ` +
    `The loop-brake extension stopped this call because an identical one already ran ${threshold} times. ` +
    `Do not retry the same arguments. Either change the arguments, use a different strategy, or tell the user what is blocking you.`
  );
}

/**
 * 闸门本体。状态只有三项：上一次调用的身份、当前连续次数、是否已警告过。
 *
 * `observe()` 返回三者之一：
 *   { action: "allow", count }          放行
 *   { action: "warn",  reason, count }   放行 + 附加警告（计数已达阈值）
 *   { action: "block", reason, count }   阻断（警告过之后仍继续，或 block 模式撞线）
 */
class LoopBrake {
  /**
   * @param {object} [options]
   * @param {object} [options.settings] 插件设置原始值，会经 normalizeSettings 净化
   */
  constructor(options = {}) {
    this.settings = normalizeSettings(options.settings);
    /** 上一次调用的指纹；null 表示还没有历史。 */
    this.last = null;
    /** 当前连续重复次数；0 表示没有活跃的连续段。 */
    this.count = 0;
    /** 是否已经在本连续段里警告过。 */
    this.warned = false;
    /** 统计：仅供状态命令与视图使用。 */
    this.stats = { checked: 0, warned: 0, blocked: 0, resets: 0, lastBlocked: null };
  }

  /** 运行期改设置（用户改插件设置后触发）。改设置会清空连续段。 */
  updateSettings(raw) {
    this.settings = normalizeSettings(raw);
    this.reset("settings changed");
  }

  /**
   * 观察一次调用。纯内存、无副作用、不抛错。
   *
   * @param {string} toolName
   * @param {unknown} input
   * @returns {{action: "allow"|"warn"|"block", reason?: string, count: number}}
   */
  observe(toolName, input) {
    const settings = this.settings;
    if (!settings.enabled) return { action: "allow", count: 0 };

    const name = typeof toolName === "string" ? toolName : String(toolName);
    if (settings.ignoreTools.includes(name)) return { action: "allow", count: 0 };

    this.stats.checked += 1;

    const current = fingerprint(name, input);

    // 身份变了：连续段结束，重新从 1 开始。这就是「连续」语义的落点。
    if (this.last !== current) {
      if (this.last !== null) this.stats.resets += 1;
      this.last = current;
      this.count = 1;
      this.warned = false;
      return { action: "allow", count: 1 };
    }

    // 身份相同：连续计数 +1。
    this.count = Math.min(this.count + 1, COUNT_CEILING);
    const count = this.count;

    const displayName = name.length > 40 ? `${name.slice(0, 40)}…` : name;
    const info = { displayName, threshold: settings.threshold, input };

    // 撞线（含超过阈值后重置计数的情况）：按模式决定警告还是阻断。
    if (count >= settings.threshold && !this.warned && settings.mode === "block") {
      this.stats.blocked += 1;
      this.stats.lastBlocked = { tool: name, at: Date.now(), count };
      return { action: "block", reason: blockReason(info), count };
    }

    // warn 模式撞线：只警告一次，放行。
    if (count >= settings.threshold && !this.warned) {
      this.warned = true;
      this.stats.warned += 1;
      return { action: "warn", reason: warnReason(info), count };
    }

    // 警告过之后仍继续同一调用：阻断，且此后每次都阻断。
    if (this.warned) {
      this.stats.blocked += 1;
      this.stats.lastBlocked = { tool: name, at: Date.now(), count };
      return { action: "block", reason: blockReason(info), count };
    }

    return { action: "allow", count };
  }

  /**
   * 由 `tool_result` 调起：工具真正跑完之后才调用。
   * 它不改判定 —— 若某个调用在 tool_call 之后被 abort，tool_result 不会到达，
   * 下一次 observe 会被新身份自然重置。这里只留给未来做「确认型」统计。
   */
  settled() {
    return undefined;
  }

  /** 清空连续段。 */
  reset(reason = "manual") {
    this.last = null;
    this.count = 0;
    this.warned = false;
    this.lastResetReason = reason;
  }

  /** 快照，供状态命令与视图使用。 */
  snapshot() {
    return {
      settings: { ...this.settings, ignoreTools: [...this.settings.ignoreTools] },
      active: this.last !== null,
      consecutive: this.count,
      warned: this.warned,
      lastResetReason: this.lastResetReason ?? null,
      stats: { ...this.stats },
    };
  }
}

export {
  COUNT_CEILING,
  DEFAULTS,
  LoopBrake,
  MAX_ARRAY,
  MAX_KEYS,
  MAX_STRING,
  MAX_STRING_TAIL,
  MAX_TOOL_NAME,
  blockReason,
  canonicalize,
  describe,
  fingerprint,
  normalizeSettings,
  warnReason,
};
