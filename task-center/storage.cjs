"use strict";

// v3 private storage layout: settings.json holds the lightweight index; each session has its own file.
const { createHash, randomBytes } = require("node:crypto");
const { readFile, stat, writeFile, rename, rm, mkdir, readdir, lstat, realpath } = require("node:fs/promises");
const { join, dirname, basename, resolve, relative, isAbsolute, sep } = require("node:path");
const state = require("./state.cjs");

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = MAX_BYTES;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const WARN_RATIO = 0.8;
const MAX_INDEX_ENTRIES = 1000;
const SETTINGS_FILE = "settings.json";
const SESSIONS_DIR = "sessions";
const ARCHIVE_DIR = "archive";
const HASH_RE = /^[a-f0-9]{64}$/;
const HASH_FILE_RE = /^([a-f0-9]{64})\.json$/;

const metricsState = {
  settingsReads: 0, sessionReads: 0, cacheHits: 0, fileReads: 0,
  writes: 0, archives: 0, migrations: 0, readMs: 0, parseMs: 0, writeMs: 0,
};
const cache = new Map();

function resetMetrics() {
  for (const key of Object.keys(metricsState)) metricsState[key] = 0;
}
function metrics() {
  return { ...metricsState, cacheEntries: cache.size };
}
function hashOf(sessionId) {
  return createHash("sha256").update(String(sessionId), "utf8").digest("hex");
}
function assertHash(hash) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) {
    state.fail("STATE_CORRUPT", "会话索引包含无效文件标识，拒绝访问归档路径。");
  }
  return hash;
}
function pathsOf(directory) {
  return {
    directory,
    settings: join(directory, SETTINGS_FILE),
    sessions: join(directory, SESSIONS_DIR),
    archive: join(directory, SESSIONS_DIR, ARCHIVE_DIR),
  };
}
function fileForHash(directory, hash, archived = false) {
  assertHash(hash);
  const root = resolve(archived ? pathsOf(directory).archive : pathsOf(directory).sessions);
  const file = resolve(root, `${hash}.json`);
  if (dirname(file) !== root) state.fail("STATE_CORRUPT", "会话文件路径越界，拒绝访问。");
  return file;
}
function fileOf(directory, sessionId, archived = false) {
  return fileForHash(directory, hashOf(sessionId), archived);
}

async function assertSafeTarget(directory, target, checkLeaf = false) {
  const rootPath = resolve(directory);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    state.fail("STATE_CORRUPT", "插件私有数据路径越界，拒绝访问。");
  }
  let rootReal;
  try { rootReal = await realpath(rootPath); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return targetPath;
    throw error;
  }
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  const count = checkLeaf ? parts.length : Math.max(0, parts.length - 1);
  let current = rootPath;
  for (let index = 0; index < count; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      state.fail("STATE_CORRUPT", "插件私有数据包含符号链接或非目录路径，拒绝访问。");
    }
    const canonical = await realpath(current);
    const canonicalRel = relative(rootReal, canonical);
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) {
      state.fail("STATE_CORRUPT", "插件私有数据路径解析后越界，拒绝访问。");
    }
  }
  return targetPath;
}

// Validate persistent index data before it can influence a file operation or capacity calculation.
function validateIndex(index) {
  if (!state.record(index)) state.fail("STATE_CORRUPT", "会话清单索引格式损坏，原数据未覆盖。");
  for (const [hash, entry] of Object.entries(index)) {
    assertHash(hash);
    if (!state.record(entry) || typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 512 ||
        hashOf(entry.id) !== hash || typeof entry.runId !== "string" || !entry.runId ||
        !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
        !Number.isFinite(entry.updatedAt) || entry.updatedAt <= 0 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !Number.isSafeInteger(entry.total) || entry.total < 0 || entry.total > state.MAX_TODOS ||
        !Number.isSafeInteger(entry.remaining) || entry.remaining < 0 || entry.remaining > entry.total ||
        typeof entry.archived !== "boolean" ||
        (entry.purgePending !== undefined && typeof entry.purgePending !== "boolean")) {
      state.fail("STATE_CORRUPT", "会话清单索引条目不符合存储契约，原数据未覆盖。");
    }
  }
  return index;
}

// Read and parse a JSON file only after checking every path component under the private data root.
async function readJsonFile(directory, file, maxBytes) {
  await assertSafeTarget(directory, file, true);
  let info;
  try { info = await stat(file); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") { cache.delete(file); return undefined; }
    throw error;
  }
  if (!info.isFile()) state.fail("STORAGE_READ_FAILED", "插件私有数据路径不是文件，未读取。");
  const cached = cache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
    metricsState.cacheHits++;
    return { value: cached.value, bytes: cached.size };
  }
  if (info.size > maxBytes) state.fail("STATE_TOO_LARGE", `插件私有数据超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 读取上限。`);
  const readStarted = process.hrtime.bigint();
  const raw = await readFile(file);
  metricsState.readMs += Number(process.hrtime.bigint() - readStarted) / 1e6;
  metricsState.fileReads++;
  if (raw.length > maxBytes) state.fail("STATE_TOO_LARGE", `插件私有数据超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 读取上限。`);
  const text = raw.toString("utf8");
  const parseStarted = process.hrtime.bigint();
  let value;
  try { value = JSON.parse(text); }
  catch { state.fail("STATE_CORRUPT", "插件私有数据不是合法 JSON。"); }
  metricsState.parseMs += Number(process.hrtime.bigint() - parseStarted) / 1e6;
  if (!state.record(value)) state.fail("STATE_CORRUPT", "插件私有数据格式损坏。");
  cache.set(file, { size: raw.length, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, value });
  return { value, bytes: raw.length };
}

async function readSettingsFile(directory) {
  let result;
  try { result = await readJsonFile(directory, pathsOf(directory).settings, MAX_SETTINGS_BYTES); }
  catch (error) {
    if (error.code === "STATE_CORRUPT" || error.code === "STATE_TOO_LARGE" || error.code === "STORAGE_READ_FAILED") throw error;
    state.fail("STORAGE_READ_FAILED", "插件私有设置读取失败，不能据此判断清单为空。");
  }
  metricsState.settingsReads++;
  return result ? result.value : {};
}

function noteMigration() {
  metricsState.migrations++;
}

async function readSessionFile(directory, sessionId, { archived = false } = {}) {
  const file = fileOf(directory, sessionId, archived);
  let result;
  try { result = await readJsonFile(directory, file, MAX_SESSION_BYTES); }
  catch (error) {
    if (error.code === "STATE_CORRUPT" || error.code === "STATE_TOO_LARGE" || error.code === "STORAGE_READ_FAILED") throw error;
    state.fail("STORAGE_READ_FAILED", "会话清单读取失败，不能据此判断清单为空。");
  }
  if (!result) return null;
  metricsState.sessionReads++;
  return { session: state.validateSession(result.value, { sessionId }), bytes: result.bytes };
}

// Prefer the live session file, then the archive; v2 inline data remains a read-only fallback.
async function readState(directory, settings, sessionId) {
  const hasStore = state.record(settings) && Object.prototype.hasOwnProperty.call(settings, state.KEY);
  const store = hasStore ? settings[state.KEY] : undefined;
  if (hasStore && !state.record(store)) state.fail("STATE_CORRUPT", "会话清单存储格式损坏，原数据未覆盖。");
  if (state.record(store) && store.version === state.LEGACY_VERSION) {
    if (!state.record(store.sessions)) state.fail("STATE_CORRUPT", "旧版会话清单存储格式损坏，原数据未覆盖。");
    const key = `session:${sessionId}`;
    if (!Object.prototype.hasOwnProperty.call(store.sessions, key)) return { ...state.EMPTY_SESSION };
    return state.validateSession(store.sessions[key], { sessionId });
  }
  if (state.record(store)) {
    if (store.version !== state.VERSION) state.fail("STATE_CORRUPT", "会话清单索引版本不受支持，原数据未覆盖。");
    validateIndex(store.index);
  }
  const current = await readSessionFile(directory, sessionId);
  if (current) return current.session;
  const archived = await readSessionFile(directory, sessionId, { archived: true });
  if (archived) return { ...archived.session, archived: true };
  return { ...state.EMPTY_SESSION };
}

function encodeSession(sessionId, session) {
  const value = {
    version: state.VERSION, sessionId, runId: session.runId,
    revision: session.revision, updatedAt: session.updatedAt, todos: session.todos,
  };
  return { value, bytes: Buffer.from(JSON.stringify(value), "utf8") };
}

async function writeAtomic(directory, file, bytes) {
  const folder = dirname(file);
  await assertSafeTarget(directory, folder, true);
  try { await mkdir(folder, { recursive: true }); }
  catch { state.fail("STORAGE_WRITE_FAILED", "插件私有目录不可写，清单未保存。"); }
  await assertSafeTarget(directory, folder, true);
  await assertSafeTarget(directory, file, true);
  const temp = join(folder, `.${basename(file, ".json")}.${randomBytes(6).toString("hex")}.tmp`);
  const started = process.hrtime.bigint();
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    state.fail("STORAGE_WRITE_FAILED", "会话清单文件写入失败，请读取当前版本后重试。");
  }
  metricsState.writeMs += Number(process.hrtime.bigint() - started) / 1e6;
  metricsState.writes++;
}

async function primeCache(file, value) {
  try {
    const info = await stat(file);
    cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, value });
  } catch { cache.delete(file); }
}

async function writeSessionFile(directory, sessionId, payload) {
  const file = fileOf(directory, sessionId);
  await writeAtomic(directory, file, payload.bytes);
  await primeCache(file, payload.value);
  const archived = fileOf(directory, sessionId, true);
  await assertSafeTarget(directory, archived, true);
  await rm(archived, { force: true }).catch(() => undefined);
  cache.delete(archived);
  return { file, bytes: payload.bytes.length };
}

// Propagate restore errors so callers never report a confirmed rollback when state is uncertain.
async function restoreSession(directory, sessionId, previous) {
  const live = fileOf(directory, sessionId);
  const archived = fileOf(directory, sessionId, true);
  cache.delete(live);
  cache.delete(archived);
  if (!previous || previous.revision < 1) {
    await assertSafeTarget(directory, live, true);
    await assertSafeTarget(directory, archived, true);
    await rm(live, { force: true });
    await rm(archived, { force: true });
    return;
  }
  const payload = encodeSession(sessionId, previous);
  if (previous.archived === true) {
    await assertSafeTarget(directory, live, true);
    await rm(live, { force: true });
    await writeAtomic(directory, archived, payload.bytes);
    return;
  }
  await writeAtomic(directory, live, payload.bytes);
  await assertSafeTarget(directory, archived, true);
  await rm(archived, { force: true });
}

function nextIndex(index, sessionId, session, bytes, summary) {
  const key = hashOf(sessionId);
  return {
    ...index,
    [key]: {
      id: sessionId, runId: session.runId, revision: session.revision, updatedAt: session.updatedAt,
      bytes, total: summary.total, remaining: summary.remainingCount, archived: false,
    },
  };
}

// Never discard archive index entries silently: reject a new entry and ask for explicit cleanup instead.
function planRetention(index, { keepSessionId, maxStored }) {
  validateIndex(index);
  const keep = hashOf(keepSessionId);
  const limit = Number.isSafeInteger(maxStored) && maxStored >= 1 ? maxStored : 1;
  const next = { ...index };
  const live = Object.entries(next).filter(([, entry]) => entry.archived !== true);
  const archive = [];
  const overflow = live.length - limit;
  if (overflow > 0) {
    const candidates = live.filter(([key]) => key !== keep)
      .sort((a, b) => (Number(a[1].updatedAt) || 0) - (Number(b[1].updatedAt) || 0))
      .slice(0, overflow);
    for (const [key, entry] of candidates) {
      archive.push(key);
      next[key] = { ...entry, archived: true };
    }
  }
  if (Object.keys(next).length > MAX_INDEX_ENTRIES) {
    state.fail("STATE_TOO_LARGE", "会话索引已满。请先通过 taskCenter.purgeArchived 手动清理已归档会话，再重试。");
  }
  return { index: next, archive };
}

async function archiveSessionFile(directory, hash) {
  const from = fileForHash(directory, hash, false);
  const to = fileForHash(directory, hash, true);
  const archive = pathsOf(directory).archive;
  try {
    await assertSafeTarget(directory, dirname(from), true);
    await assertSafeTarget(directory, archive, true);
    await mkdir(archive, { recursive: true });
    await assertSafeTarget(directory, archive, true);
    await assertSafeTarget(directory, from, true);
    await assertSafeTarget(directory, to, true);
    await rename(from, to);
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  cache.delete(from);
  cache.delete(to);
  metricsState.archives++;
  return true;
}

// Remove both possible locations because an earlier archive rename may have failed.
async function purgeArchived(directory, hashes) {
  const removed = [];
  const failed = [];
  for (const hash of new Set(hashes)) {
    assertHash(hash);
    const files = [fileForHash(directory, hash, true), fileForHash(directory, hash, false)];
    let errorCode = null;
    for (const file of files) {
      try {
        await assertSafeTarget(directory, file, true);
        await rm(file, { force: true });
      } catch (error) { errorCode ??= error.code || "STORAGE_WRITE_FAILED"; }
      cache.delete(file);
    }
    if (errorCode) failed.push({ hash, code: errorCode });
    else removed.push(hash);
  }
  return { removed, failed };
}

// Delete hash-named archive files which were orphaned by older index-pruning behavior.
async function purgeOrphanedArchives(directory, indexedHashes) {
  const folder = pathsOf(directory).archive;
  let names;
  try {
    await assertSafeTarget(directory, folder, true);
    names = await readdir(folder);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { removed: 0, failed: [] };
    return { removed: 0, failed: [{ code: error.code || "STORAGE_READ_FAILED" }] };
  }
  let removed = 0;
  const failed = [];
  for (const name of names) {
    const match = HASH_FILE_RE.exec(name);
    if (!match || indexedHashes.has(match[1])) continue;
    const file = fileForHash(directory, match[1], true);
    try {
      await assertSafeTarget(directory, file, true);
      await rm(file, { force: true });
      removed++;
    } catch (error) { failed.push({ hash: match[1], code: error.code || "STORAGE_WRITE_FAILED" }); }
    cache.delete(file);
  }
  return { removed, failed };
}

// Include indexed archives and any older orphaned archive files in the total storage budget.
async function archiveInventory(directory) {
  const folder = pathsOf(directory).archive;
  let names;
  try {
    await assertSafeTarget(directory, folder, true);
    names = await readdir(folder);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return new Map();
    if (error.code === "STATE_CORRUPT") throw error;
    state.fail("STORAGE_READ_FAILED", "归档目录读取失败，无法确认任务数据容量。");
  }
  const files = new Map();
  for (const name of names) {
    const match = HASH_FILE_RE.exec(name);
    if (!match) continue;
    const file = fileForHash(directory, match[1], true);
    try {
      await assertSafeTarget(directory, file, true);
      const info = await lstat(file);
      if (info.isFile()) files.set(match[1], info.size);
    } catch (error) {
      if (error.code !== "ENOENT") {
        state.fail(error.code === "STATE_CORRUPT" ? "STATE_CORRUPT" : "STORAGE_READ_FAILED", "归档文件状态读取失败，无法确认任务数据容量。");
      }
    }
  }
  return files;
}

function capacityOf(settings, options = {}) {
  const store = state.record(settings) && state.record(settings[state.KEY]) ? settings[state.KEY] : null;
  let liveBytes = 0, archivedBytes = 0, sessions = 0, archived = 0;
  const indexedHashes = new Set();
  const archiveFiles = options.archiveFiles instanceof Map ? options.archiveFiles : null;
  if (store && store.version === state.VERSION && state.record(store.index)) {
    validateIndex(store.index);
    for (const [hash, entry] of Object.entries(store.index)) {
      indexedHashes.add(hash);
      if (entry.archived === true) {
        archived++;
        archivedBytes += archiveFiles?.has(hash) ? archiveFiles.get(hash) : entry.bytes;
      } else {
        sessions++;
        liveBytes += entry.bytes;
      }
    }
  }
  if (archiveFiles) {
    for (const [hash, bytes] of archiveFiles) {
      if (!indexedHashes.has(hash)) {
        archived++;
        archivedBytes += bytes;
      }
    }
  }
  const settingsBytes = Number.isFinite(options.settingsBytes) && options.settingsBytes >= 0
    ? options.settingsBytes : Buffer.byteLength(JSON.stringify(settings ?? {}), "utf8");
  const usedBytes = liveBytes + archivedBytes + settingsBytes;
  return {
    usedBytes, limitBytes: MAX_BYTES,
    percent: Math.min(100, Math.round(usedBytes / MAX_BYTES * 100)),
    warning: usedBytes >= MAX_BYTES * WARN_RATIO,
    sessions, archived,
  };
}

function invalidate(directory, sessionId) {
  const paths = pathsOf(directory);
  cache.delete(paths.settings);
  if (sessionId !== undefined) {
    cache.delete(fileOf(directory, sessionId));
    cache.delete(fileOf(directory, sessionId, true));
  }
}

module.exports = {
  MAX_BYTES, MAX_SETTINGS_BYTES, MAX_SESSION_BYTES, WARN_RATIO, MAX_INDEX_ENTRIES,
  hashOf, assertHash, validateIndex, pathsOf, fileOf, fileForHash, readSettingsFile, readState,
  encodeSession, writeSessionFile, nextIndex, planRetention, archiveSessionFile,
  purgeArchived, purgeOrphanedArchives, archiveInventory, restoreSession, capacityOf,
  invalidate, metrics, resetMetrics, noteMigration,
};
