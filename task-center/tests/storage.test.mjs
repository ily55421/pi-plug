import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import storage from "../storage.cjs";

test("私有文件：缺失、JSON损坏、非对象、合法数据、目录和超限分别处理", async () => {
  assert.ok(process.env.PI_SCRATCH_DIR, "请将 PI_SCRATCH_DIR 设为项目内专用临时目录");
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-storage-"));
  const file = join(directory, "settings.json");
  try {
    assert.deepEqual(await storage.readSettingsFile(directory), {});
    for (const raw of ["{broken", "null", "[]", "42"]) {
      await writeFile(file, raw);
      await assert.rejects(storage.readSettingsFile(directory), { code: "STATE_CORRUPT" });
    }
    await writeFile(file, JSON.stringify({ guardEnabled: false, todoSessions: { version: 2, sessions: {} } }));
    assert.equal((await storage.readSettingsFile(directory)).guardEnabled, false);
    await writeFile(file, " ".repeat(storage.MAX_BYTES + 1));
    await assert.rejects(storage.readSettingsFile(directory), { code: "STATE_TOO_LARGE" });
    await rm(file); await mkdir(file);
    await assert.rejects(storage.readSettingsFile(directory), { code: "STORAGE_READ_FAILED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
