/*
 * local.token-meter 的累计统计（history.js）与发布路径（main.js）测试。
 *
 * 用 node:test + node:assert/strict，通过 createRequire 直接加载 CJS 插件源码。
 * 测试全部在临时目录里造转录本 fixture，不读也不写任何真实宿主数据。
 *
 * 运行（在工作区根执行）：node --test tests/token-meter.test.mjs
 * 临时目录默认走系统 temp，可用 TOKEN_METER_TEST_TMP 指定（例如指向会话 scratch）。
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(path.resolve(here, ".."), "token-meter");

const history = require(path.join(pluginRoot, "history.js"));
const main = require(path.join(pluginRoot, "main.js"));
const hostRead = require(path.join(pluginRoot, "host-read.js"));

const TMP_ROOT = process.env.TOKEN_METER_TEST_TMP || os.tmpdir();
const { aggregateHistory, CACHE_VERSION, MAX_CHART_DAYS, MIN_PLAUSIBLE_DURATION_MS } = history;

/* ------------------------------------------------------------------ 夹具 */

const createdRoots = [];

/** 造一个宿主目录：sessions/ 下按名字写入 jsonl 内容。 */
function makeHost(files = {}) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, "tm-test-"));
  createdRoots.push(root);
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    const body = Array.isArray(lines) ? lines.join("\n") + "\n" : lines;
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  return root;
}

test.after(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** 本地时间构造，保证 localDayKey 落回同一日期（不受时区影响）。 */
function at(year, month, day, hour = 12, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

/** 造一行助手回复记录；字段名与宿主转录本一致。 */
function assistantLine(options = {}) {
  const usage = {
    inputTokens: options.input || 0,
    outputTokens: options.output || 0,
    cacheReadTokens: options.cacheRead || 0,
    cacheWriteTokens: options.cacheWrite || 0,
    reasoningTokens: options.reasoning || 0,
  };
  const meta = { modelId: options.model || "test-model", usage };
  if (options.durationMs !== undefined) meta.responseDurationMs = options.durationMs;
  if (options.agentName) meta.agentName = options.agentName;
  if (options.parentToolCallId) meta.parentToolCallId = options.parentToolCallId;
  const blocks = [];
  if (options.text) blocks.push({ type: "text", text: options.text });
  if (options.thinking) blocks.push({ type: "thinking", text: options.thinking });
  return JSON.stringify({
    type: "message",
    role: "assistant",
    createdAt: options.at.toISOString(),
    meta,
    blocks,
  });
}

/** 求和某个扁平桶列表的 token 总量。 */
const sumTotals = (buckets) => buckets.reduce((acc, item) => acc + item.tokens.total, 0);

/** 求和柱状图条目的总量 —— 条目形状是 { key, total, replies }，没有 tokens 子对象。 */
const sumChart = (bars) => bars.reduce((acc, item) => acc + item.total, 0);

/* ------------------------------------------------------- 三级累计与自洽性 */

test("按天分桶，年与月由天派生，三级数字完全自洽", () => {
  const root = makeHost({
    "a.jsonl": [
      assistantLine({ at: at(2026, 9, 21), model: "m1", input: 100, output: 10, durationMs: 1000 }),
      assistantLine({ at: at(2026, 9, 21), model: "m1", input: 200, output: 20, durationMs: 1000 }),
      assistantLine({ at: at(2026, 9, 20), model: "m2", input: 300, output: 30, durationMs: 1000 }),
    ],
    "b.jsonl": [
      assistantLine({ at: at(2026, 8, 31), model: "m2", input: 400, output: 40, durationMs: 1000 }),
      assistantLine({ at: at(2025, 12, 31), model: "m3", input: 500, output: 50, durationMs: 1000 }),
    ],
  });

  const result = aggregateHistory(root, { now: at(2026, 9, 21, 23, 0).getTime() });

  assert.equal(result.ok, true);
  assert.equal(result.files.total, 2);
  assert.equal(result.files.rescanned, 2, "无缓存时全部重扫");
  assert.equal(result.totals.replies, 5);

  // 三级与按模型求和，必须都等于总量 —— 这正是「年/月由天派生」要保证的性质。
  const grand = result.totals.tokens.total;
  assert.equal(sumTotals(result.years), grand, "年合计等于总量");
  assert.equal(sumTotals(result.months), grand, "月合计等于总量");
  assert.equal(sumTotals(result.days), grand, "天合计等于总量");
  assert.equal(sumTotals(result.models), grand, "模型合计等于总量");

  // 排序：年/月倒序（最近在前），天也是最近在前。
  assert.deepEqual(
    result.years.map((y) => y.key),
    ["2026", "2025"],
  );
  assert.deepEqual(
    result.months.map((m) => m.key),
    ["2026-09", "2026-08", "2025-12"],
  );
  assert.deepEqual(
    result.days.map((d) => d.key),
    ["2026-09-21", "2026-09-20", "2026-08-31", "2025-12-31"],
  );

  assert.equal(result.years[0].activeDays, 3, "2026 年有 3 天有记录");
  assert.equal(result.months[0].activeDays, 2, "2026-09 有 2 天有记录");
  assert.equal(result.days[0].activeDays, 1, "单天桶的 activeDays 恒为 1");
  assert.equal(result.totals.activeDays, 4, "总量覆盖全部 4 天");
  assert.equal(result.totals.modelCount, 3);
  assert.equal(result.daysTruncated, false);
});

test("days 明细按 maxDays 截断，但总量仍按全部天数精确计算", () => {
  const lines = [];
  for (let day = 10; day <= 14; day += 1) {
    lines.push(assistantLine({ at: at(2026, 9, day), model: "m1", input: 100, output: 10, durationMs: 1000 }));
  }
  const root = makeHost({ "a.jsonl": lines });

  const result = aggregateHistory(root, { maxDays: 2 });

  assert.equal(result.days.length, 2, "只保留最近 2 天明细");
  assert.equal(result.daysTruncated, true);
  assert.deepEqual(
    result.days.map((d) => d.key),
    ["2026-09-14", "2026-09-13"],
  );
  assert.equal(result.totals.replies, 5, "总量仍是 5 天全量");
  assert.equal(result.years[0].replies, 5);
});

test("空 sessions 目录返回成功但全零，缺目录则报错", () => {
  const empty = aggregateHistory(makeHost({}));
  assert.equal(empty.ok, true);
  assert.equal(empty.totals.replies, 0);
  assert.equal(empty.totals.tokens.total, 0);
  assert.deepEqual(empty.years, []);
  assert.deepEqual(empty.months, []);
  assert.deepEqual(empty.days, []);
  assert.deepEqual(empty.models, []);
  assert.deepEqual(empty.chart, []);

  const missing = aggregateHistory(path.join(TMP_ROOT, "tm-does-not-exist-" + Date.now()));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "NO_SESSION_DIR");
});

/* ------------------------------------------------------------ 速度与用时 */

test("峰值排除不可信样本，但总量与平均仍包含它们", () => {
  const root = makeHost({
    "a.jsonl": [
      // 92 tok / 1ms = 92000 tok/s，被宿主计时精度主导的噪声读数。
      assistantLine({ at: at(2026, 9, 21, 10), model: "m1", input: 0, output: 92, durationMs: 1 }),
      // 正常样本：500 tok / 1000ms = 500 tok/s。
      assistantLine({ at: at(2026, 9, 21, 11), model: "m1", input: 0, output: 500, durationMs: 1000 }),
    ],
  });

  const result = aggregateHistory(root);
  const day = result.days[0];

  assert.equal(day.implausible, 1, "1ms 的样本被排除出峰值");
  assert.equal(day.peakSpeed, 500, "峰值取可信样本的最大值");
  assert.equal(day.tokens.output, 592, "被排除的样本仍计入输出总量");
  assert.equal(day.replies, 2);
  // 平均包含全部有速度的样本：(92000 + 500) / 2 = 46250。
  assert.equal(day.avgSpeed, 46250, "平均值包含噪声样本，与面板会话口径一致");
  assert.equal(result.totals.peakSpeed, 500, "全局峰值同样被保护");

  // 下限的边界：恰好等于下限的样本可信，低 1ms 不可信。
  const boundary = history.isPlausibleSpeedSample({ speed: 1000, durationMs: MIN_PLAUSIBLE_DURATION_MS });
  assert.equal(boundary, true);
  assert.equal(history.isPlausibleSpeedSample({ speed: 1000, durationMs: MIN_PLAUSIBLE_DURATION_MS - 1 }), false);
  assert.equal(history.isPlausibleSpeedSample({ speed: 0, durationMs: 1000 }), false);
  assert.equal(history.isPlausibleSpeedSample({ speed: null, durationMs: 1000 }), false);
});

test("用时来源自述：reported / gap / unknown 之和等于回复条数", () => {
  const root = makeHost({
    "a.jsonl": [
      // 有上报时长。
      assistantLine({ at: at(2026, 9, 21, 10, 0), model: "m1", output: 100, durationMs: 500 }),
      // 无上报时长，与下一条间隔 3 秒 → gap 回填。
      assistantLine({ at: at(2026, 9, 21, 10, 1), model: "m1", output: 100 }),
      // 有上报时长。
      assistantLine({ at: at(2026, 9, 21, 10, 1, 3), model: "m1", output: 100, durationMs: 700 }),
      // 无上报时长，且是文件里最后一条 → 拿不到下一条，来源 unknown。
      assistantLine({ at: at(2026, 9, 21, 10, 2), model: "m1", output: 100 }),
    ],
  });

  const result = aggregateHistory(root);
  const day = result.days[0];

  assert.equal(day.durationReported, 2);
  assert.equal(day.durationGap, 1);
  assert.equal(day.durationUnknown, 1);
  assert.equal(
    day.durationReported + day.durationGap + day.durationUnknown,
    day.replies,
    "三种来源之和必须等于条数，不能有记录既不报时长也不算未知",
  );
  assert.equal(day.durationMs, 500 + 3000 + 700, "gap 回填的 3 秒计入累计用时");
});

test("间隔超过 MAX_GAP_MS 时不用它估算用时", () => {
  const root = makeHost({
    "a.jsonl": [
      assistantLine({ at: at(2026, 9, 21, 10, 0), model: "m1", output: 100 }),
      // 间隔 30 分钟，远超 10 分钟上限：这段空闲不代表生成耗时。
      assistantLine({ at: at(2026, 9, 21, 10, 30), model: "m1", output: 100, durationMs: 400 }),
    ],
  });

  const day = aggregateHistory(root).days[0];
  assert.equal(day.durationUnknown, 1, "超上限的间隔不用于估算");
  assert.equal(day.durationReported, 1);
  assert.equal(day.durationMs, 400, "只累计真实上报的时长");
});

test("输出 token 为 0 时按可见文本估算，并标记 estimated", () => {
  const root = makeHost({
    "a.jsonl": [
      // 宿主没给 outputTokens，只有 blocks：40 个字符 / 4 = 10 tok。
      assistantLine({ at: at(2026, 9, 21, 10), model: "m1", output: 0, durationMs: 1000, text: "x".repeat(40) }),
    ],
  });

  const day = aggregateHistory(root).days[0];
  assert.equal(day.tokens.output, 0, "上报的 usage 不被篡改");
  assert.equal(day.estimated, 1, "标记为估算");
  assert.equal(day.avgSpeed, 10, "速度按估算输出计算：10 / 1s");
});

/* ------------------------------------------------------------ 模型聚合 */

test("模型聚合：占比之和为 100、按总量降序、天数独立统计", () => {
  const root = makeHost({
    "a.jsonl": [
      assistantLine({ at: at(2026, 9, 21), model: "fast", input: 0, output: 600, durationMs: 1000 }),
      assistantLine({ at: at(2026, 9, 20), model: "fast", input: 0, output: 400, durationMs: 1000 }),
      assistantLine({ at: at(2026, 9, 20), model: "slow", input: 0, output: 100, durationMs: 1000 }),
    ],
  });

  const result = aggregateHistory(root);
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["fast", "slow"],
    "按总量降序",
  );

  const fast = result.models[0];
  assert.equal(fast.replies, 2);
  assert.equal(fast.tokens.output, 1000);
  assert.equal(fast.days, 2, "fast 出现在 2 天里");
  assert.equal(fast.avgSpeed, 500, "(600 + 400) / 2");
  assert.equal(result.models[1].days, 1);

  const shareSum = result.models.reduce((acc, m) => acc + m.share, 0);
  assert.ok(Math.abs(shareSum - 100) < 0.2, `占比之和应接近 100，实际 ${shareSum}`);
  assert.equal(fast.share, 90.9, "1000 / 1100 → 90.9%");
});

test("缺失 modelId 的记录归入 (未知模型)，不会丢失", () => {
  const line = JSON.parse(assistantLine({ at: at(2026, 9, 21), input: 10, output: 5, durationMs: 1000 }));
  delete line.meta.modelId;
  const root = makeHost({ "a.jsonl": [JSON.stringify(line)] });

  const result = aggregateHistory(root);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].modelId, "(未知模型)");
  assert.equal(result.totals.tokens.total, 15);
});

/* ---------------------------------------------------------------- 缓存 */

test("缓存按文件指纹复用：首次全扫，二次全部命中", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
    "b.jsonl": [assistantLine({ at: at(2026, 9, 20), model: "m1", output: 200, durationMs: 1000 })],
  });
  const cacheFile = path.join(root, "cache.json");

  const first = aggregateHistory(root, { cacheFile });
  assert.equal(first.files.rescanned, 2);
  assert.equal(first.files.reused, 0);
  assert.equal(first.cacheSaved, true);
  assert.equal(fs.existsSync(cacheFile), true);
  assert.equal(fs.existsSync(`${cacheFile}.tmp`), false, "临时文件不残留");

  const second = aggregateHistory(root, { cacheFile });
  assert.equal(second.files.rescanned, 0, "第二次全部命中缓存");
  assert.equal(second.files.reused, 2);
  assert.equal(second.totals.tokens.total, first.totals.tokens.total, "缓存命中不改变结果");
  assert.equal(second.totals.replies, first.totals.replies);
  assert.deepEqual(
    second.days.map((d) => d.key),
    first.days.map((d) => d.key),
  );
});

test("只有变化的文件重扫，其余继续命中", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
    "b.jsonl": [assistantLine({ at: at(2026, 9, 20), model: "m1", output: 200, durationMs: 1000 })],
  });
  const cacheFile = path.join(root, "cache.json");
  aggregateHistory(root, { cacheFile });

  const bFile = path.join(root, "sessions", "b.jsonl");
  fs.writeFileSync(
    bFile,
    [assistantLine({ at: at(2026, 9, 20), model: "m1", output: 200, durationMs: 1000 }), assistantLine({ at: at(2026, 9, 20), model: "m1", output: 50, durationMs: 1000 })].join("\n") + "\n",
    "utf8",
  );
  // Windows 上连续写入可能拿到相同 mtime，显式推后时间保证指纹真的变了。
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(bFile, later, later);

  const third = aggregateHistory(root, { cacheFile });
  assert.equal(third.files.rescanned, 1, "只有被改动的文件重扫");
  assert.equal(third.files.reused, 1);
  assert.equal(third.totals.replies, 3, "新记录被算进去");
  assert.equal(third.totals.tokens.total, 350);
});

test("force 忽略缓存全量重扫", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const cacheFile = path.join(root, "cache.json");
  aggregateHistory(root, { cacheFile });

  const forced = aggregateHistory(root, { cacheFile, force: true });
  assert.equal(forced.files.rescanned, 1);
  assert.equal(forced.files.reused, 0);
  assert.equal(forced.totals.tokens.total, 100, "重扫结果与缓存一致");
});

test("缓存损坏或版本不符时静默降级为全量重扫", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const cacheFile = path.join(root, "cache.json");

  fs.writeFileSync(cacheFile, "{ 这不是 JSON", "utf8");
  const broken = aggregateHistory(root, { cacheFile });
  assert.equal(broken.ok, true, "坏缓存不是错误");
  assert.equal(broken.files.rescanned, 1);
  assert.equal(broken.totals.tokens.total, 100);

  fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION + 1, files: {} }), "utf8");
  const stale = aggregateHistory(root, { cacheFile });
  assert.equal(stale.files.rescanned, 1, "版本不符时缓存作废");
  assert.equal(stale.totals.tokens.total, 100);

  // 版本不符的缓存被覆盖成当前版本，下一次即命中。
  const after = aggregateHistory(root, { cacheFile });
  assert.equal(after.files.reused, 1);
});

test("缓存写入失败只是拿不到加速，不影响结果", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  // 把缓存路径指向一个必然失败的非法位置（父级是文件）。
  const bogus = path.join(root, "sessions", "a.jsonl", "cache.json");

  const result = aggregateHistory(root, { cacheFile: bogus });
  assert.equal(result.ok, true);
  assert.equal(result.cacheSaved, false);
  assert.equal(result.totals.tokens.total, 100, "数字照常算出来");
});

/* -------------------------------------------------------------- 容错 */

test("坏行被计数但不影响其余记录", () => {
  const root = makeHost({
    "a.jsonl": [
      assistantLine({ at: at(2026, 9, 21, 10), model: "m1", output: 100, durationMs: 1000 }),
      "{ 半截 JSON",
      "",
      JSON.stringify({ type: "message", role: "user", createdAt: at(2026, 9, 21, 11).toISOString() }),
      JSON.stringify({ type: "message", role: "assistant", createdAt: at(2026, 9, 21, 12).toISOString() }),
      assistantLine({ at: at(2026, 9, 21, 13), model: "m1", output: 200, durationMs: 1000 }),
    ],
  });

  const result = aggregateHistory(root);
  assert.equal(result.ok, true);
  assert.equal(result.totals.replies, 2, "只统计带 usage 的助手回复");
  assert.equal(result.totals.tokens.output, 300);

  const cache = history.readCache(path.join(root, "c.json"));
  assert.deepEqual(cache.files, {}, "空缓存结构");
});

test("非 .jsonl 与目录名不会被当成转录本", () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
    "notes.txt": "不该被读",
    "session.revisions.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 999, durationMs: 1000 })],
    "import-codex-x.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 777, durationMs: 1000 })],
  });
  // 造一个以 .jsonl 结尾的目录：它不是文件，必须被跳过而不是当成空转录本。
  fs.mkdirSync(path.join(root, "sessions", "b.jsonl"), { recursive: true });

  const result = aggregateHistory(root);
  assert.equal(result.files.total, 1, "只认 a.jsonl");
  assert.equal(result.totals.tokens.output, 100);
  assert.equal(hostRead.isTranscriptFile("x.revisions.jsonl"), false);
  assert.equal(hostRead.isTranscriptFile("import-claude-code-y.jsonl"), false);
  assert.equal(hostRead.isTranscriptFile("normal.jsonl"), true);
});

/* ------------------------------------------------------ main.js 发布路径 */

/** 造一个最小 pi 宿主，并重置插件模块内的缓存。 */
function installHost(dataPath) {
  const writes = [];
  const settings = {};
  global.pi = {
    plugin: {
      async getDataPath() {
        if (dataPath instanceof Error) throw dataPath;
        return dataPath;
      },
      async setSettings(patch) {
        writes.push(Object.keys(patch));
        Object.assign(settings, patch);
      },
      async getSettings() {
        return settings;
      },
    },
    commands: { async register() {}, async unregister() {} },
    ui: { async openPanel() {}, async closePanel() {}, async showToast() {} },
  };
  main.__test.resetCache();
  return { writes, settings };
}

test("publishHistory 把聚合结果写进 meterHistory 设置", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const dataPath = fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-"));
  createdRoots.push(dataPath);
  const host = installHost(dataPath);

  const result = await main.__test.publishHistory(root);

  assert.equal(result.ok, true);
  assert.equal(host.writes.length, 1, "首次发布写一次设置");
  assert.deepEqual(host.writes[0], ["meterHistory"]);
  const published = host.settings.meterHistory;
  assert.equal(published.ok, true);
  assert.equal(published.totals.tokens.total, 100);
  assert.equal(published.years.length, 1);
  assert.equal(published.months.length, 1);
  assert.equal(published.models.length, 1);
  assert.ok(Array.isArray(published.chart));
  assert.equal(fs.existsSync(path.join(dataPath, "history-cache.json")), true, "缓存在插件自己的数据目录");
});

test("数字没变时不再重复写设置", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const dataPath = fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-"));
  createdRoots.push(dataPath);
  const host = installHost(dataPath);

  await main.__test.publishHistory(root);
  await main.__test.publishHistory(root);
  await main.__test.publishHistory(root);

  assert.equal(host.writes.length, 1, "冷扫转热缓存不产生新的落盘");
});

test("数字变化后重新发布", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const dataPath = fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-"));
  createdRoots.push(dataPath);
  const host = installHost(dataPath);

  await main.__test.publishHistory(root);

  const file = path.join(root, "sessions", "a.jsonl");
  fs.appendFileSync(file, assistantLine({ at: at(2026, 9, 21, 13), model: "m1", output: 400, durationMs: 1000 }) + "\n", "utf8");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);

  await main.__test.publishHistory(root);

  assert.equal(host.writes.length, 2, "数字变了才再写一次");
  assert.equal(host.settings.meterHistory.totals.tokens.total, 500);
});

test("聚合失败时不写设置，也不抛错给调用方", async () => {
  const host = installHost(fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-")));

  const result = await main.__test.publishHistory(path.join(TMP_ROOT, "tm-nope-" + Date.now()));

  assert.equal(result.ok, false);
  assert.equal(result.error, "NO_SESSION_DIR");
  assert.equal(host.writes.length, 0, "读不到就什么都不发");
});

test("拿不到数据目录时退化成每次全量重扫，功能不受影响", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  const host = installHost(new Error("宿主没有提供数据目录"));

  const result = await main.__test.publishHistory(root);

  assert.equal(result.ok, true, "没有缓存也要能算");
  assert.equal(result.totals.tokens.total, 100);
  assert.equal(result.cacheSaved, false);
  assert.equal(host.writes.length, 1);
});

test("常量与视图约定保持一致", () => {
  assert.deepEqual(main.__test.COMMAND_IDS, ["tokenMeter.openWidget", "tokenMeter.summary"]);
  assert.equal(main.__test.HISTORY_POLL_MS, 60000, "累计统计走独立慢节奏");
  assert.equal(MAX_CHART_DAYS, 30);
  assert.ok(history.MAX_SNAPSHOT_DAYS >= MAX_CHART_DAYS, "明细天数上限不小于柱状图天数");
});

/* ------------------------------------------------ 覆盖安装后的版本自检 */

/*
 * 背景：宿主在「安装插件包」时只重载插件进程，不会销毁已有视图的 webview
 * （只有停用 / 卸载 / 崩溃 / dev 重载才销毁）。所以覆盖安装后，面板里可能仍在
 * 跑安装前的旧页面——数据是新的，界面却是旧的。
 *
 * 对策：插件进程把版本号随快照发布，视图发现不一致就自行 reload 一次。
 * 下面既验证「发布端确实带版本」，也验证「视图端自检逻辑存在且有一致性守卫」。
 */

const pluginRootDir = path.join(path.resolve(here, ".."), "token-meter");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRootDir, "manifest.json"), "utf8"));
const panelSource = fs.readFileSync(path.join(pluginRootDir, "views", "panel.js"), "utf8");
const widgetSource = fs.readFileSync(path.join(pluginRootDir, "views", "widget.js"), "utf8");
const mainSource = fs.readFileSync(path.join(pluginRootDir, "main.js"), "utf8");

test("快照带上插件版本号，供视图自检", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21), model: "m1", output: 100, durationMs: 1000 })],
  });
  installHost(fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-")));
  const snapshot = await main.__test.publishSnapshot(root, { full: true });
  assert.equal(snapshot.pluginVersion, manifest.version, "版本号取自 manifest，不手写");
});

test("两个视图的内置版本号与 manifest 一致", () => {
  const read = (src) => {
    const m = src.match(/VIEW_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  };
  assert.equal(read(panelSource), manifest.version, "面板版本号必须跟上 manifest");
  assert.equal(read(widgetSource), manifest.version, "浮窗版本号必须跟上 manifest");
});

test("视图自检：版本不一致时只 reload 一次，且用跨 reload 的守卫", () => {
  for (const [name, src] of [["panel.js", panelSource], ["widget.js", widgetSource]]) {
    assert.match(src, /function shouldReloadForVersion/, name + " 必须有自检函数");
    assert.match(src, /sessionStorage\.getItem/, name + " 守卫必须跨 reload 存活");
    assert.match(src, /window\.location\.reload\(\)/, name + " 发现落后要重新加载");
    const calls = src.match(/shouldReloadForVersion\(/g) || [];
    assert.ok(calls.length >= 2, name + " 自检函数必须被调用（定义 + 至少一处调用）");
  }
});

test("版本自检不会因为磁盘页面较旧而无限刷新", () => {
  const storage = new Map();
  const fakeWindow = {
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
  };
  const VIEW_VERSION = manifest.version;
  const shouldReload = (snapshotVersion) => {
    if (!snapshotVersion || snapshotVersion === VIEW_VERSION) return false;
    try {
      const key = "tokenMeter.versionReload";
      if (fakeWindow.sessionStorage.getItem(key) === snapshotVersion) return false;
      fakeWindow.sessionStorage.setItem(key, snapshotVersion);
      return true;
    } catch {
      return false;
    }
  };

  assert.equal(shouldReload(undefined), false, "拿不到版本就不动");
  assert.equal(shouldReload(VIEW_VERSION), false, "版本一致不刷新");
  assert.equal(shouldReload("9.9.9"), true, "第一次发现落后要刷新");
  assert.equal(shouldReload("9.9.9"), false, "同一版本不重复刷新");
  assert.equal(shouldReload("8.8.8"), true, "换了新版本可以再刷一次");
  assert.equal(shouldReload("8.8.8"), false, "换版本后同样只刷一次");
});

test("拿不到 sessionStorage 时宁可不自动重载", () => {
  const shouldReload = (snapshotVersion, storage) => {
    if (!snapshotVersion || snapshotVersion === "0.3.1") return false;
    try {
      if (storage.getItem("k") === snapshotVersion) return false;
      storage.setItem("k", snapshotVersion);
      return true;
    } catch {
      return false;
    }
  };
  const throwing = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };
  assert.equal(shouldReload("9.9.9", throwing), false, "存储不可用时显示旧界面，而不是刷屏");
});

test("main.js 的版本号来自 manifest，避免两处漂移", () => {
  assert.match(mainSource, /require\("\.\/manifest\.json"\)\.version/, "不应手写版本字符串");
  assert.match(mainSource, /pluginVersion: PLUGIN_VERSION/, "降级快照也要带版本");
});

/* ------------------------------------------------- 周期切换（0.4.0） */

/*
 * 背景：0.3.x 的看板上，柱状图恒为「近 30 天」、模型用量恒为「全历史累计」，
 * 两者都不读当前周期。于是点「月 / 年」时只有四个主数字在动，下面两块纹丝不动，
 * 看起来就像切换失灵。
 *
 * 对策：聚合层为日 / 月 / 年各发布一份 { key, empty, summary, chart, models }，
 * 视图切换时整块换掉。下面验证口径、自洽性与「切换真的会换内容」。
 */

/** 造一份跨年 / 跨月 / 跨天的数据，便于观察三个周期的差异。 */
function periodFixture() {
  return makeHost({
    "a.jsonl": [
      // 今天（相对 now 而言）：2026-09-21。
      assistantLine({ at: at(2026, 9, 21, 10), model: "today-model", output: 100, durationMs: 1000 }),
      // 本月早些时候。
      assistantLine({ at: at(2026, 9, 10, 10), model: "month-model", output: 200, durationMs: 1000 }),
      assistantLine({ at: at(2026, 9, 10, 11), model: "month-model", output: 300, durationMs: 1000 }),
      // 今年早些时候（上个月）。
      assistantLine({ at: at(2026, 7, 5, 10), model: "year-model", output: 400, durationMs: 1000 }),
      // 去年：不该出现在任何「今年 / 本月 / 今日」的桶里。
      assistantLine({ at: at(2025, 12, 31, 10), model: "old-model", output: 900, durationMs: 1000 }),
    ],
  });
}

const PERIOD_NOW = at(2026, 9, 21, 23, 0).getTime();

test("periods 给出三个周期，各自的口径是「今天 / 本月 / 今年」", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const { periods } = result;

  assert.ok(periods, "必须发布 periods");
  assert.deepEqual(Object.keys(periods).sort(), ["day", "month", "year"]);

  // key 就是当前周期，不是「最近一个有记录的周期」。
  assert.equal(periods.day.key, "2026-09-21");
  assert.equal(periods.month.key, "2026-09");
  assert.equal(periods.year.key, "2026");

  // 四个主数字分别对应今天 / 本月 / 今年。
  assert.equal(periods.day.summary.tokens.total, 100, "今日只有 today-model 那条");
  assert.equal(periods.day.summary.replies, 1);
  assert.equal(periods.month.summary.tokens.total, 600, "本月含 9-21 与 9-10 的回复");
  assert.equal(periods.month.summary.replies, 3);
  assert.equal(periods.year.summary.tokens.total, 1000, "今年不含去年的 900");
  assert.equal(periods.year.summary.replies, 4);
});

test("periods 的按模型明细只含该周期的模型，占比按该周期总量重算", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const { periods } = result;

  assert.deepEqual(
    periods.day.models.map((m) => m.modelId),
    ["today-model"],
    "今日只有今天用过的模型",
  );
  assert.deepEqual(
    periods.month.models.map((m) => m.modelId),
    ["month-model", "today-model"],
    "本月按总量降序，且不含 7 月与去年的模型",
  );
  assert.deepEqual(
    periods.year.models.map((m) => m.modelId),
    ["month-model", "year-model", "today-model"],
    "今年按总量降序（500 / 400 / 100），且不含 old-model",
  );

  // 占比的分母是该周期自己的总量：本月 month-model 500 / 600 = 83.3%。
  const monthModel = periods.month.models.find((m) => m.modelId === "month-model");
  assert.equal(monthModel.share, 83.3, "占比按本月总量算，而不是全历史");
  const monthShareSum = periods.month.models.reduce((acc, m) => acc + m.share, 0);
  assert.ok(Math.abs(monthShareSum - 100) < 0.2, `本月占比之和应接近 100，实际 ${monthShareSum}`);

  // 与全量口径对比：全量里 month-model 是 500 / 1900，明显不同。
  const globalMonthModel = result.models.find((m) => m.modelId === "month-model");
  assert.equal(globalMonthModel.share, 26.3, "全量口径下 month-model 占 500 / 1900");
  assert.notEqual(monthModel.share, globalMonthModel.share, "周期占比必须区别于全量占比");
});

test("periods 的柱状图跟着周期换粒度：日→天、月→月、年→年", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const { periods } = result;

  assert.deepEqual(
    periods.day.chart.map((b) => b.key),
    ["2025-12-31", "2026-07-05", "2026-09-10", "2026-09-21"],
    "日粒度：有记录的每一天，升序",
  );
  assert.deepEqual(
    periods.month.chart.map((b) => b.key),
    ["2025-12", "2026-07", "2026-09"],
    "月粒度：有记录的每一月",
  );
  assert.deepEqual(
    periods.year.chart.map((b) => b.key),
    ["2025", "2026"],
    "年粒度：有记录的每一年",
  );

  // 三套柱状图的求和都等于全量 —— 换粒度不该丢数。
  const grand = result.totals.tokens.total;
  assert.equal(sumChart(periods.day.chart), grand);
  assert.equal(sumChart(periods.month.chart), grand);
  assert.equal(sumChart(periods.year.chart), grand);

  // 月柱是当月各天之和，不是当月某一天。
  const september = periods.month.chart.find((b) => b.key === "2026-09");
  assert.equal(september.total, 600, "2026-09 的柱子是 9-21 与 9-10 之和");
  assert.equal(september.replies, 3);
});

test("periods 与三级明细自洽：周期数字等于对应桶的数字", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const { periods } = result;

  const monthBucket = result.months.find((m) => m.key === "2026-09");
  const yearBucket = result.years.find((y) => y.key === "2026");
  const dayBucket = result.days.find((d) => d.key === "2026-09-21");

  assert.equal(periods.month.summary.tokens.total, monthBucket.tokens.total);
  assert.equal(periods.month.summary.replies, monthBucket.replies);
  assert.equal(periods.month.summary.avgSpeed, monthBucket.avgSpeed);
  assert.equal(periods.year.summary.tokens.total, yearBucket.tokens.total);
  assert.equal(periods.day.summary.tokens.total, dayBucket.tokens.total);
  assert.equal(periods.day.summary.activeDays, 1, "单天桶的 activeDays 恒为 1");
});

test("周期内没有记录时给全零并标 empty，而不是退回最近一个有记录的周期", () => {
  // 记录只到 2026-09-10，而「现在」是 2026-10-03：今天与本月都还没有记录。
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 10), model: "m1", output: 500, durationMs: 1000 })],
  });
  const result = aggregateHistory(root, { now: at(2026, 10, 3, 12).getTime() });
  const { periods } = result;

  assert.equal(periods.day.key, "2026-10-03");
  assert.equal(periods.day.empty, true, "今天没有记录");
  assert.equal(periods.day.summary.tokens.total, 0, "不能把 9-10 的数字挂到「今日」下面");
  assert.deepEqual(periods.day.models, []);

  assert.equal(periods.month.key, "2026-10");
  assert.equal(periods.month.empty, true);
  assert.equal(periods.month.summary.tokens.total, 0);

  // 今年仍有记录：2026 年那条在 9 月。
  assert.equal(periods.year.empty, false);
  assert.equal(periods.year.summary.tokens.total, 500);
});

test("一条记录都没有时 periods 仍然形状完整，视图不必写特例", () => {
  const result = aggregateHistory(makeHost({}), { now: PERIOD_NOW });

  assert.equal(result.ok, true);
  for (const scope of ["day", "month", "year"]) {
    const pack = result.periods[scope];
    assert.ok(pack, scope + " 必须存在");
    assert.equal(pack.empty, true, scope + " 应标记为空");
    assert.equal(pack.summary.tokens.total, 0);
    assert.deepEqual(pack.chart, []);
    assert.deepEqual(pack.models, []);
  }
});

test("兼容 0.3.x 的旧视图：chart 仍是日粒度，models 仍是全量", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });

  // 覆盖安装后旧页面可能还在跑，它读的是 history.chart 与 history.models。
  assert.deepEqual(
    result.chart.map((b) => b.key),
    result.periods.day.chart.map((b) => b.key),
    "chart 保留为日粒度",
  );
  assert.equal(sumTotals(result.models), result.totals.tokens.total, "models 仍是全历史累计");
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["old-model", "month-model", "year-model", "today-model"],
    "全量模型按总量降序",
  );
});

test("柱状图换粒度后仍受 MAX_CHART_DAYS 约束，且保留最近的桶", () => {
  // 造 40 个月的数据：月柱状图只该保留最近 30 根。
  const lines = [];
  for (let index = 0; index < 40; index += 1) {
    const year = 2023 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    lines.push(assistantLine({ at: at(year, month, 15), model: "m1", output: 10, durationMs: 1000 }));
  }
  const root = makeHost({ "a.jsonl": lines });
  const result = aggregateHistory(root);

  assert.equal(result.months.length, 40, "明细桶不截断");
  assert.equal(result.periods.month.chart.length, MAX_CHART_DAYS, "柱状图最多 30 根");
  assert.equal(result.periods.day.chart.length, MAX_CHART_DAYS);
  const keys = result.periods.month.chart.map((b) => b.key);
  assert.deepEqual(keys, [...keys].sort(), "柱状图升序");
  assert.equal(keys[keys.length - 1], result.months[0].key, "最后一根是最新的月份");
});

test("视图按周期取数：panel.js 读 periods 而非固定的 chart / models", () => {
  // 视图是纯 DOM 脚本，这里用源码契约检查：切换周期必须改变柱状图与模型列表的取数来源。
  assert.match(panelSource, /history\.periods/, "必须读聚合层发布的 periods");
  assert.match(panelSource, /function periodData/, "必须有一个「取当前周期」的函数");
  assert.match(panelSource, /periodData\(history\)/, "渲染时必须真的用它取数");
  const chartFn = panelSource.match(/function renderChart[\s\S]*?\n  \}/);
  assert.ok(chartFn, "必须能定位 renderChart");
  assert.match(chartFn[0], /periodData\(/, "柱状图必须跟随周期");
  const modelsFn = panelSource.match(/function renderModels[\s\S]*?\n  \}/);
  assert.ok(modelsFn, "必须能定位 renderModels");
  assert.match(modelsFn[0], /periodData\(/, "模型列表必须跟随周期");
  // 兜底：拿不到 periods 时仍要能退回旧字段，避免旧插件进程配新页面时白屏。
  assert.match(panelSource, /history\.models/, "必须有退回旧字段的兜底");
  assert.match(panelSource, /is-current/, "柱子高亮应跟随当前周期");
});

test("跨天时即使总量未变也要重新发布（否则「今日」会一直显示昨天）", async () => {
  const root = makeHost({
    "a.jsonl": [assistantLine({ at: at(2026, 9, 21, 10), model: "m1", output: 100, durationMs: 1000 })],
  });
  const dataPath = fs.mkdtempSync(path.join(TMP_ROOT, "tm-data-"));
  createdRoots.push(dataPath);
  const host = installHost(dataPath);

  // 第一天发布。
  const day1 = await main.__test.publishHistory(root, { now: at(2026, 9, 21, 23, 0).getTime() });
  assert.equal(host.writes.length, 1);
  assert.equal(day1.periods.day.key, "2026-09-21");

  // 跨天：一条新记录都没有，总量完全不变，但「今日」的 key 变了。
  const day2 = await main.__test.publishHistory(root, { now: at(2026, 9, 22, 0, 5).getTime() });
  assert.equal(host.writes.length, 2, "周期 key 变了就必须重新发布");
  assert.equal(host.settings.meterHistory.periods.day.key, "2026-09-22");
  assert.equal(host.settings.meterHistory.periods.day.empty, true, "新的一天还没有记录");
  assert.equal(host.settings.meterHistory.periods.day.summary.tokens.total, 0);
  assert.equal(day2.totals.tokens.total, 100, "总量本身没变");

  // 同一天内再发布一次：数字与周期都没变，不该重复落盘。
  await main.__test.publishHistory(root, { now: at(2026, 9, 22, 0, 6).getTime() });
  assert.equal(host.writes.length, 2, "同一天内不重复写设置");
});

/* ------------------------------------------- 点柱子切换（0.4.1） */

/*
 * 需求：点柱状图里某一根柱子，整块看板（四个主数字 / 明细表高亮 / 模型用量）
 * 都切到那一段时间，而不只是当前周期。
 *
 * 实现要点：插件进程为柱状图窗口内的每个桶发布一份 { key, current, summary, models }，
 * 视图点击后本地换数据源 —— 不走设置往返，所以点击是即时的。
 */

test("periods 为柱状图窗口内每个桶发布明细，与柱子一一对应", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const { periods } = result;

  for (const scope of ["day", "month", "year"]) {
    const pack = periods[scope];
    assert.equal(
      pack.buckets.length,
      pack.chart.length,
      scope + "：桶明细数量必须等于柱子数量，否则会有柱子点不出东西",
    );
    assert.deepEqual(
      pack.buckets.map((b) => b.key),
      pack.chart.map((b) => b.key),
      scope + "：桶明细与柱子必须同序同 key",
    );
  }
});

test("每个桶的 summary 与该柱子一致，且带自己的模型明细", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });
  const day = result.periods.day;

  for (const bucket of day.buckets) {
    const bar = day.chart.find((b) => b.key === bucket.key);
    assert.ok(bar, bucket.key + " 必须有对应柱子");
    assert.equal(bucket.summary.tokens.total, bar.total, bucket.key + "：桶总量与柱子一致");
    assert.equal(bucket.summary.replies, bar.replies, bucket.key + "：桶条数与柱子一致");
  }

  // 9-10 那天只有 month-model 两条（200 + 300），模型明细必须只含它。
  const sep10 = day.buckets.find((b) => b.key === "2026-09-10");
  assert.deepEqual(
    sep10.models.map((m) => m.modelId),
    ["month-model"],
    "该天的模型明细只含当天用过的模型",
  );
  assert.equal(sep10.summary.tokens.total, 500);
});

test("桶明细只覆盖柱状图窗口（最近 MAX_CHART_DAYS 个），不无谓膨胀", () => {
  const lines = [];
  for (let index = 0; index < 40; index += 1) {
    const year = 2023 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    lines.push(assistantLine({ at: at(year, month, 15), model: "m1", output: 10, durationMs: 1000 }));
  }
  const result = aggregateHistory(makeHost({ "a.jsonl": lines }));

  assert.equal(result.months.length, 40, "月桶本身不截断");
  assert.equal(result.periods.month.buckets.length, MAX_CHART_DAYS, "桶明细与柱子同样只留最近 30 个");
  assert.equal(result.periods.day.buckets.length, MAX_CHART_DAYS);
});

test("桶明细标出哪个是当前周期", () => {
  const result = aggregateHistory(periodFixture(), { now: PERIOD_NOW });

  for (const scope of ["day", "month", "year"]) {
    const pack = result.periods[scope];
    const marked = pack.buckets.filter((b) => b.current);
    assert.equal(marked.length, 1, scope + "：恰好一个桶标为当前周期");
    assert.equal(marked[0].key, pack.key, scope + "：标为当前的必须是当前周期的 key");
  }
});

test("视图：柱子可点击，且主数字 / 表格 / 模型列表都跟随选中桶", () => {
  // 柱子必须是真的按钮（可点击、可聚焦），而不是只能看不能点的 div。
  assert.match(panelSource, /createElement\("button"\)[\s\S]{0,400}chart-bar/, "柱子应渲染成 button");
  assert.match(panelSource, /function selectBucket/, "必须有选中逻辑");
  assert.match(panelSource, /addEventListener\("click", \(\) => selectBucket/, "柱子必须绑定点击");
  assert.match(panelSource, /function activeBucket/, "必须有「当前展示的桶」解析函数");

  // 四个主数字、明细表高亮、模型用量都要走 activeBucket，不能只让柱子自己变。
  const tiles = panelSource.match(/function renderScopeTiles[\s\S]*?\n  \}/);
  assert.ok(tiles, "必须能定位 renderScopeTiles");
  assert.match(tiles[0], /activeBucket\(/, "主数字必须跟随选中桶");
  const table = panelSource.match(/function renderBoardTable[\s\S]*?\n  \}/);
  assert.ok(table, "必须能定位 renderBoardTable");
  assert.match(table[0], /activeBucket\(/, "明细表高亮必须跟随选中桶");
  const models = panelSource.match(/function renderModels[\s\S]*?\n  \}/);
  assert.ok(models, "必须能定位 renderModels");
  assert.match(models[0], /activeBucket\(/, "模型用量必须跟随选中桶");

  // 切换周期要丢掉选中态：上一个周期选中的那天在另一个粒度下没有意义。
  const seg = panelSource.match(/function renderSeg[\s\S]*?\n  \}/);
  assert.ok(seg, "必须能定位 renderSeg");
  assert.match(seg[0], /state\.selectedKey = null/, "换周期必须重置选中态");
});

test("视图：柱子是按钮，CSS 必须清掉按钮默认外观", () => {
  const cssSource = fs.readFileSync(path.join(pluginRootDir, "views", "panel.css"), "utf8");
  const barRule = cssSource.match(/\.chart-bar \{[\s\S]*?\n\}/);
  assert.ok(barRule, "必须能定位 .chart-bar 规则");
  assert.match(barRule[0], /background: none/, "必须清掉按钮背景");
  assert.match(barRule[0], /border: none/, "必须清掉按钮边框");
  assert.match(barRule[0], /padding: 0/, "必须清掉按钮内边距");
  assert.match(barRule[0], /cursor: pointer/, "可点击要给出指针光标");
});

test("CSS 括号配平：规则块未闭合会吞掉后面所有样式", () => {
  const cssSource = fs.readFileSync(path.join(pluginRootDir, "views", "panel.css"), "utf8");
  const open = (cssSource.match(/\{/g) || []).length;
  const close = (cssSource.match(/\}/g) || []).length;
  assert.equal(open, close, `花括号必须配平（左 ${open} / 右 ${close}）`);

  // 规则外的裸属性行意味着上一个块没闭合 —— 这正是 0.4.0 样式崩掉的原因。
  let depth = 0;
  const orphans = [];
  cssSource.split(/\r?\n/).forEach((line, index) => {
    const before = depth;
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (before === 0 && /^\s+[a-z-]+\s*:/.test(line) && !line.includes("@")) {
      orphans.push(`${index + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(orphans, [], "不应存在规则外的裸属性行");
});
