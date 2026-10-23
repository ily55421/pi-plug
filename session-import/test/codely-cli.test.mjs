// @ts-check
/**
 * Tests for the Codely CLI source adapter (~/.codely-cli/tmp/<sha256>/chats/*.jsonl):
 *  - fixture transcript scans into a summary with id/title/projectPath/counts
 *  - streaming rewrites of the same msg.id keep the LAST content, first order
 *  - bootstrap user message yields cwd but is not imported as a user turn
 *  - toolCalls become tool messages; isMeta messages are skipped
 *  - projectPathForHash reverse-hashes ~/.codely/recent-projects.json
 *
 * Run:
 *   node --test test/codely-cli.test.mjs
 */
"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cc = require(`${PLUGIN_DIR}/lib/sources/codely-cli.js`);

let tmp;
const jsonl = (arr) => arr.map((o) => JSON.stringify(o)).join("\n");

const SESSION_ID = "fed6ba00-d18b-4462-b67a-052570ca890e";

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "codely-cli-test-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("codely-cli adapter shape", () => {
  test("exports source, label, scan, convert", () => {
    assert.strictEqual(cc.source, "codely-cli");
    assert.ok(cc.label.length > 0);
    assert.strictEqual(typeof cc.scan, "function");
    assert.strictEqual(typeof cc.scanFast, "function");
    assert.strictEqual(typeof cc.convert, "function");
  });

  test("tmpDirFor honors a custom home argument", () => {
    assert.strictEqual(cc.tmpDirFor("/custom/home"), path.join("/custom/home", ".codely-cli", "tmp"));
    assert.strictEqual(cc.tmpDirFor(), path.join(os.homedir(), ".codely-cli", "tmp"));
  });
});

describe("cwdFromBootstrap", () => {
  test("extracts a Windows path from the CLI bootstrap message", () => {
    const text =
      "This is the Codely CLI. I'm currently working in the directory: E:\\code\\source\\rmatrix\nLet me know if you need anything.";
    assert.strictEqual(cc.cwdFromBootstrap(text), "E:\\code\\source\\rmatrix");
  });

  test("returns null for text without a directory", () => {
    assert.strictEqual(cc.cwdFromBootstrap("just a normal question"), null);
    assert.strictEqual(cc.cwdFromBootstrap(null), null);
  });
});

describe("codely-cli scan + convert with a fixture tree", () => {
  test("scans the fixture transcript into a summary", async () => {
    const cwd = "E:\\code\\source\\rmatrix";
    const hash = crypto.createHash("sha256").update(cwd, "utf8").digest("hex");
    const chatsDir = path.join(tmp, ".codely-cli", "tmp", hash, "chats");
    await mkdir(chatsDir, { recursive: true });
    // A second recent-projects.json so the hash fallback can be exercised too.
    await mkdir(path.join(tmp, ".codely"), { recursive: true });
    await writeFile(
      path.join(tmp, ".codely", "recent-projects.json"),
      JSON.stringify([{ path: cwd, lastOpen: 1789720000 }]),
      "utf8",
    );
    const filePath = path.join(chatsDir, `${SESSION_ID}.jsonl`);
    await writeFile(
      filePath,
      jsonl([
        {
          t: "header",
          v: 1,
          seq: 0,
          durableSessionId: SESSION_ID,
          projectHash: hash,
          startedAt: "2026-09-04T18:09:07.594Z",
        },
        {
          t: "put",
          seq: 1,
          msg: {
            id: "m1",
            timestamp: "2026-09-04T18:09:07.595Z",
            type: "user",
            content: [
              {
                text:
                  "This is the Codely CLI. I'm currently working in the directory: E:\\code\\source\\rmatrix",
              },
            ],
          },
        },
        {
          t: "put",
          seq: 2,
          msg: {
            id: "m2",
            timestamp: "2026-09-04T18:09:08.000Z",
            type: "user",
            content: "帮我分析这个 Vue3 大屏项目",
          },
        },
        {
          t: "put",
          seq: 3,
          msg: {
            id: "m3",
            timestamp: "2026-09-04T18:09:09.000Z",
            type: "gemini",
            content: "Got it. Thanks for the context!",
            model: "codely-air",
          },
        },
        {
          t: "put",
          seq: 4,
          msg: {
            id: "m4",
            timestamp: "2026-09-04T18:09:10.000Z",
            type: "session_snapshot",
            content: "meta",
            attachmentMeta: { type: "session_snapshot", isMeta: true },
          },
        },
        {
          t: "ckpt",
          seq: 5,
          msgCount: 2,
          lastUpdated: "2026-09-04T18:10:44.824Z",
          title: "分析 Vue3 大屏项目",
        },
      ]),
      "utf8",
    );

    // The adapter computes everything from os.homedir(); the fixture tree is a
    // standalone home, so call the internal helpers through the exported scan
    // by pointing HOME at the fixture via monkeypatching os.homedir.
    const realHomedir = os.homedir;
    os.homedir = () => tmp;
    try {
      const sessions = await cc.scan();
      assert.ok(Array.isArray(sessions));
      assert.strictEqual(sessions.length, 1);
      const s = sessions[0];
      assert.strictEqual(s.source, "codely-cli");
      assert.strictEqual(s.externalId, SESSION_ID);
      assert.strictEqual(s.title, "分析 Vue3 大屏项目");
      assert.strictEqual(s.fullTitle, "分析 Vue3 大屏项目");
      assert.strictEqual(s.projectPath, "E:\\code\\source\\rmatrix");
      assert.strictEqual(s.projectName, "rmatrix");
      assert.strictEqual(s.modelId, "codely-air");
      assert.strictEqual(s.createdAt, "2026-09-04T18:09:07.594Z");
      assert.strictEqual(s.updatedAt, "2026-09-04T18:10:44.824Z");
      assert.strictEqual(s.messageCount, 2);
      assert.strictEqual(s.filePath, filePath);

      const converted = await cc.convert(s);
      assert.strictEqual(converted.session.id, `import-codely-cli-${SESSION_ID}`);
      assert.strictEqual(converted.session.title, "分析 Vue3 大屏项目");
      // Bootstrap turn is dropped; meta snapshot is dropped.
      assert.deepStrictEqual(
        converted.messages.map((m) => m.role),
        ["user", "assistant"],
      );
      assert.strictEqual(converted.messages[0].content, "帮我分析这个 Vue3 大屏项目");
      assert.strictEqual(converted.messages[1].content, "Got it. Thanks for the context!");
    } finally {
      os.homedir = realHomedir;
    }
  });

  test("keeps the LAST rewrite of a streaming message, in first-seen order", async () => {
    const chatsDir = path.join(tmp, ".codely-cli", "tmp", "deadbeef", "chats");
    await mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, "stream-test.jsonl");
    await writeFile(
      filePath,
      jsonl([
        { t: "header", v: 1, seq: 0, durableSessionId: "stream-test", projectHash: "deadbeef", startedAt: "2026-09-04T18:09:07.594Z" },
        { t: "put", seq: 1, msg: { id: "u1", timestamp: "2026-09-04T18:09:08.000Z", type: "user", content: "question" } },
        { t: "put", seq: 2, msg: { id: "a1", timestamp: "2026-09-04T18:09:09.000Z", type: "gemini", content: "partial" } },
        { t: "put", seq: 3, msg: { id: "a1", timestamp: "2026-09-04T18:09:09.000Z", type: "gemini", content: "final answer", model: "codely-air" } },
        {
          t: "put",
          seq: 4,
          msg: {
            id: "a2",
            timestamp: "2026-09-04T18:09:10.000Z",
            type: "gemini",
            content: "with a tool",
            toolCalls: [
              {
                id: "call-1",
                name: "read_file",
                args: { path: "a.txt" },
                status: "completed",
                timestamp: "2026-09-04T18:09:10.500Z",
                result: { functionResponse: { response: { output: "file body" } } },
              },
            ],
          },
        },
      ]),
      "utf8",
    );
    const converted = await cc.convert({
      externalId: "stream-test",
      title: "stream",
      fullTitle: "stream",
      filePath,
      projectPath: null,
      modelId: null,
      createdAt: "2026-09-04T18:09:07.594Z",
      updatedAt: "2026-09-04T18:09:10.000Z",
    });
    assert.deepStrictEqual(
      converted.messages.map((m) => m.role),
      ["user", "assistant", "assistant", "tool"],
    );
    assert.strictEqual(converted.messages[1].content, "final answer");
    const tool = converted.messages[3];
    assert.strictEqual(tool.toolName, "read_file");
    assert.strictEqual(tool.content, "file body");
    assert.strictEqual(tool.toolStatus, "success");
    assert.deepStrictEqual(tool.toolArgs, { path: "a.txt" });
  });

  test("projectPathForHash reverse-hashes a recent-projects entry", async () => {
    const cwd = "E:\\workspace\\tf";
    const hash = crypto.createHash("sha256").update(cwd, "utf8").digest("hex");
    await mkdir(path.join(tmp, ".codely"), { recursive: true });
    await writeFile(
      path.join(tmp, ".codely", "recent-projects.json"),
      JSON.stringify([{ path: cwd, lastOpen: 1789720000 }, { path: "E:\\other" }]),
      "utf8",
    );
    assert.strictEqual(await cc.projectPathForHash(hash, tmp), cwd);
    assert.strictEqual(await cc.projectPathForHash("no-such-hash", tmp), null);
  });

  test("scan returns [] when ~/.codely-cli/tmp is missing", async () => {
    const realHomedir = os.homedir;
    os.homedir = () => path.join(tmp, "empty-home");
    try {
      const sessions = await cc.scan();
      assert.deepStrictEqual(sessions, []);
    } finally {
      os.homedir = realHomedir;
    }
  });
});
