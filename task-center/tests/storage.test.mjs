import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import storage from "../storage.cjs";
import state from "../state.cjs";

const task = (content = "任务", status = "pending") => ({ content, status, priority: "medium" });
const session = (overrides = {}) => ({ runId: "run-a", revision: 1, updatedAt: 1000, todos: [task()], ...overrides });

async function scratch() {
  assert.ok(process.env.PI_SCRATCH_DIR, "请将 PI_SCRATCH_DIR 设为项目内专用临时目录");
  return mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-storage-"));
}

test("私有文件：缺失、JSON损坏、非对象、合法数据、目录和超限分别处理", async () => {
  const directory = await scratch();
  const file = join(directory, "settings.json");
  try {
    assert.deepEqual(await storage.readSettingsFile(directory), {});
    for (const raw of ["{broken", "null", "[]", "42"]) {
      await writeFile(file, raw);
      storage.invalidate(directory);
      await assert.rejects(storage.readSettingsFile(directory), { code: "STATE_CORRUPT" });
    }
    await writeFile(file, JSON.stringify({ guardEnabled: false, todoSessions: { version: 3, index: {} } }));
    storage.invalidate(directory);
    assert.equal((await storage.readSettingsFile(directory)).guardEnabled, false);
    await writeFile(file, " ".repeat(storage.MAX_BYTES + 1));
    storage.invalidate(directory);
    await assert.rejects(storage.readSettingsFile(directory), { code: "STATE_TOO_LARGE" });
    await rm(file); await mkdir(file);
    storage.invalidate(directory);
    await assert.rejects(storage.readSettingsFile(directory), { code: "STORAGE_READ_FAILED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("文件未变化时命中缓存，字节数变化后重新读取", async () => {
  const directory = await scratch();
  const file = join(directory, "settings.json");
  try {
    await writeFile(file, JSON.stringify({ marker: "一" }));
    storage.invalidate(directory);
    storage.resetMetrics();
    assert.equal((await storage.readSettingsFile(directory)).marker, "一");
    const afterFirst = storage.metrics();
    assert.equal((await storage.readSettingsFile(directory)).marker, "一");
    const afterSecond = storage.metrics();
    assert.equal(afterSecond.fileReads, afterFirst.fileReads, "缓存命中不读盘");
    assert.ok(afterSecond.cacheHits > afterFirst.cacheHits);
    await writeFile(file, JSON.stringify({ marker: "第二个更长的标记" }));
    assert.equal((await storage.readSettingsFile(directory)).marker, "第二个更长的标记");
    assert.equal(storage.metrics().fileReads, afterSecond.fileReads + 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("会话文件严格校验版本、会话归属和索引哈希", async () => {
  const directory = await scratch();
  try {
    assert.equal((await storage.readState(directory, {}, "A")).revision, 0);
    const payload = storage.encodeSession("A", session());
    await storage.writeSessionFile(directory, "A", payload);
    const read = await storage.readState(directory, {}, "A");
    assert.equal(read.todos[0].content, "任务");
    assert.equal(read.revision, 1);
    assert.equal(read.archived, false);

    const file = storage.fileOf(directory, "A");
    const body = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...body, sessionId: "B" }));
    storage.invalidate(directory, "A");
    await assert.rejects(storage.readState(directory, {}, "A"), { code: "STATE_CORRUPT" });

    await writeFile(file, JSON.stringify({ ...body, todos: [{ content: "x", status: "oops", priority: "low" }] }));
    storage.invalidate(directory, "A");
    await assert.rejects(storage.readState(directory, {}, "A"), { code: "STATE_CORRUPT" });
    const malicious = { todoSessions: { version: 3, index: { "../../victim": {} } } };
    await assert.rejects(storage.readState(directory, malicious, "A"), { code: "STATE_CORRUPT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("拒绝伪造归档路径，不能删除插件私有目录之外的文件", async () => {
  const directory = await scratch();
  const victim = join(directory, "victim.json");
  try {
    await writeFile(victim, "keep");
    await assert.rejects(storage.purgeArchived(directory, ["../../../victim"]), { code: "STATE_CORRUPT" });
    assert.equal(await readFile(victim, "utf8"), "keep");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("拒绝经由目录符号链接清理私有目录之外的归档文件", async (t) => {
  const directory = await scratch();
  const outside = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-outside-"));
  try {
    const hash = storage.hashOf("outside-session");
    const victim = join(outside, `${hash}.json`);
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(victim, "keep");
    try {
      await symlink(outside, join(sessions, "archive"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("当前环境不允许创建目录符号链接"); return; }
      throw error;
    }
    const result = await storage.purgeArchived(directory, [hash]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.equal(await readFile(victim, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


test("旧版内联数据可只读回退，未知存储版本显式失败", async () => {
  const directory = await scratch();
  try {
    const legacy = {
      todoSessions: { version: 2, sessions: { "session:A": { runId: "r", revision: 2, updatedAt: 5, todos: [task("旧")] } } },
    };
    const read = await storage.readState(directory, legacy, "A");
    assert.equal(read.todos[0].content, "旧");
    assert.equal(read.revision, 2);
    for (const bad of [{ version: 1, sessions: {} }, { version: 3, index: [] }, null, "x"]) {
      await assert.rejects(storage.readState(directory, { todoSessions: bad }, "A"), { code: "STATE_CORRUPT" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("归档文件计入容量，显式清理可移除索引归档与旧版遗留文件", async () => {
  const directory = await scratch();
  try {
    const first = storage.encodeSession("A", session({ updatedAt: 1 }));
    const second = storage.encodeSession("B", session({ updatedAt: 2 }));
    await storage.writeSessionFile(directory, "A", first);
    await storage.writeSessionFile(directory, "B", second);
    let index = storage.nextIndex({}, "A", session({ updatedAt: 1 }), first.bytes.length, state.summarize([task()]));
    index = storage.nextIndex(index, "B", session({ updatedAt: 2 }), second.bytes.length, state.summarize([task()]));
    const planned = storage.planRetention(index, { keepSessionId: "B", maxStored: 1 });
    assert.equal(planned.archive.length, 1);
    assert.equal(planned.archive[0], storage.hashOf("A"));
    assert.equal(await storage.archiveSessionFile(directory, planned.archive[0]), true);
    const settings = { todoSessions: { version: 3, index: planned.index } };
    const archived = await storage.readState(directory, settings, "A");
    assert.equal(archived.archived, true);

    const orphanHash = storage.hashOf("orphan");
    const orphanFile = storage.fileForHash(directory, orphanHash, true);
    await writeFile(orphanFile, "orphan bytes");
    const inventory = await storage.archiveInventory(directory);
    const capacity = storage.capacityOf(settings, { settingsBytes: 100, archiveFiles: inventory });
    assert.equal(capacity.sessions, 1);
    assert.equal(capacity.archived, 2);
    assert.equal(capacity.usedBytes, first.bytes.length + second.bytes.length + Buffer.byteLength("orphan bytes") + 100);

    const result = await storage.purgeArchived(directory, planned.archive);
    assert.deepEqual(result.removed, planned.archive);
    assert.deepEqual(result.failed, []);
    const orphaned = await storage.purgeOrphanedArchives(directory, new Set(Object.keys(planned.index)));
    assert.equal(orphaned.removed, 1);
    assert.equal(orphaned.failed.length, 0);
    assert.equal((await storage.readState(directory, settings, "A")).revision, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("索引提交失败可回滚会话文件，保留原有版本", async () => {
  const directory = await scratch();
  try {
    await storage.writeSessionFile(directory, "A", storage.encodeSession("A", session()));
    const next = storage.encodeSession("A", session({ revision: 2, todos: [task("更新")] }));
    await storage.writeSessionFile(directory, "A", next);
    assert.equal((await storage.readState(directory, {}, "A")).revision, 2);
    await storage.restoreSession(directory, "A", session());
    assert.equal((await storage.readState(directory, {}, "A")).revision, 1);
    assert.equal((await storage.readState(directory, {}, "A")).todos[0].content, "任务");
    await storage.restoreSession(directory, "A", { revision: 0, todos: [] });
    assert.equal((await storage.readState(directory, {}, "A")).revision, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("索引达到上限时拒绝新记录而不是丢弃归档索引", () => {
  const index = {};
  for (let i = 0; i < storage.MAX_INDEX_ENTRIES; i++) {
    const id = `session-${i}`;
    index[storage.hashOf(id)] = {
      id, runId: `run-${i}`, revision: 1, updatedAt: i + 1,
      bytes: 10, total: 0, remaining: 0, archived: true,
    };
  }
  const withCurrent = storage.nextIndex(index, "current", session({ runId: "run-current", updatedAt: storage.MAX_INDEX_ENTRIES + 1, todos: [] }), 10, state.summarize([]));
  assert.throws(
    () => storage.planRetention(withCurrent, { keepSessionId: "current", maxStored: 5 }),
    { code: "STATE_TOO_LARGE" },
  );
  assert.equal(Object.keys(index).length, storage.MAX_INDEX_ENTRIES, "原索引必须保持完整");
  assert.equal(Object.keys(withCurrent).length, storage.MAX_INDEX_ENTRIES + 1);
});
