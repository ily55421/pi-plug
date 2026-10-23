// @ts-check
/**
 * Tests for the Trae CN source adapter.
 *
 * The Trae CN database is SQLCipher v4 encrypted (page 4096, reserve 80).
 * To test end-to-end without Trae installed, this suite BUILDS its own
 * encrypted fixture:
 *   1. create a plaintext SQLite DB with node:sqlite (Trae's schema),
 *   2. transform it to reserved-bytes-80 layout (shift every b-tree page's
 *      cell content down by 96 bytes on page 1 / 80 elsewhere, exactly the
 *      space SQLCipher's salt + IV + HMAC consume),
 *   3. encrypt each page with AES-256-CBC per the SQLCipher v4 layout.
 *
 * Then scan()/convert() must decrypt the fixture and return the sessions.
 *
 * Run:
 *   node --test test/trae-cn.test.mjs
 */
"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const trae = require(`${PLUGIN_DIR}/lib/sources/trae-cn.js`);
const scFile = require(`${PLUGIN_DIR}/lib/sqlcipher-file.js`);

const PAGE = 4096;
const RESERVE = 80;
const IV_OFF = PAGE - RESERVE;

let tmp;
const dbDir = {};

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "trae-cn-test-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture machinery
// ---------------------------------------------------------------------------

/** Read a 24-bit big-endian int at offset. */
function readUInt24BE(buf, off) {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}
function writeUInt24BE(buf, off, v) {
  buf[off] = (v >> 16) & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
  buf[off + 2] = v & 0xff;
}

/**
 * Shift every b-tree page's cell content down so the plaintext database has
 * SQLCipher's usable size (pageSize - reserve, minus another 16 bytes on
 * page 1 for the salt). Only leaf pages appear in the compact fixture; any
 * interior / overflow / freelist page aborts the build.
 */
function transformToReservedLayout(plain) {
  const out = Buffer.from(plain);
  out[20] = RESERVE; // header byte: reserved bytes per page
  const pages = Math.floor(out.length / PAGE);
  for (let n = 1; n <= pages; n++) {
    const base = (n - 1) * PAGE;
    const typeOff = n === 1 ? 100 : 0;
    const type = out[base + typeOff];
    if (type !== 0x0d && type !== 0x05 && type !== 0x0a && type !== 0x02) {
      throw new Error(`fixture: page ${n} has unsupported page type 0x${type.toString(16)}`);
    }
    const hdr = type === 0x05 || type === 0x02 ? 12 : 8;
    const nCell = out.readUInt16BE(base + typeOff + 3);
    const contentStart = out.readUInt16BE(base + typeOff + 5);
    if (contentStart === 0 || contentStart > PAGE) {
      throw new Error(`fixture: page ${n} implausible contentStart ${contentStart}`);
    }
    const freeblockHead = out.readUInt16BE(base + typeOff + 1);
    const delta = n === 1 ? RESERVE + 16 : RESERVE;
    if (contentStart < delta) {
      throw new Error(`fixture: page ${n} has no room to shift (${contentStart} < ${delta})`);
    }
    // memmove the cell area down by delta (Buffer.copy is overlap-safe)
    out.copy(out, base + contentStart - delta, base + contentStart, base + PAGE);
    out.fill(0, base + PAGE - delta, base + PAGE);
    out.writeUInt16BE(contentStart - delta, base + typeOff + 5);
    // free-block chain: every offset stored inside the page moves by delta
    if (freeblockHead !== 0) {
      out.writeUInt16BE(freeblockHead - delta, base + typeOff + 1);
      let cur = freeblockHead;
      let guard = 0;
      while (cur !== 0 && guard++ < 1000) {
        const newPos = base + cur - delta;
        const next = out.readUInt16BE(newPos);
        out.writeUInt16BE(next === 0 ? 0 : next - delta, newPos);
        cur = next;
      }
      if (guard >= 1000) throw new Error(`fixture: page ${n} free-block chain too long`);
    }
    for (let c = 0; c < nCell; c++) {
      const ptrOff = base + typeOff + hdr + 2 * c;
      const ptr = out.readUInt16BE(ptrOff);
      if (ptr < delta) throw new Error(`fixture: page ${n} cell pointer underflow`);
      out.writeUInt16BE(ptr - delta, ptrOff);
    }
  }
  return out;
}

/** Encrypt a reserved-80 plaintext DB with the SQLCipher v4 page layout. */
function encryptAsSqlcipherV4(plain, key, salt) {
  const pages = plain.length / PAGE;
  const out = Buffer.alloc(plain.length);
  for (let n = 1; n <= pages; n++) {
    const base = (n - 1) * PAGE;
    const iv = crypto.randomBytes(16);
    const ctStart = n === 1 ? 16 : 0;
    const ctLen = IV_OFF - ctStart; // page 1: 4000, others: 4016
    const c = crypto.createCipheriv("aes-256-cbc", key, iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(plain.subarray(base, base + ctLen)), c.final()]);
    assert.equal(ct.length, ctLen);
    if (n === 1) salt.copy(out, base);
    ct.copy(out, base + ctStart);
    iv.copy(out, base + IV_OFF);
    // bytes [IV_OFF+16, PAGE) stay zero — the HMAC area, unused by the fixture
  }
  return out;
}

async function buildFixtureDb() {
  const plainPath = path.join(tmp, "fixture-plain.db");
  const encPath = path.join(tmp, "fixture-trae.db");

  // 1) plaintext database with Trae CN's schema and sample rows
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(plainPath);
  db.exec(`
    PRAGMA page_size = 4096;
    CREATE TABLE project (
      project_id TEXT PRIMARY KEY,
      user_id TEXT,
      absolute_path TEXT,
      type TEXT,
      deleted_at INTEGER
    );
    CREATE TABLE chat_session (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      session_title TEXT,
      work_mode TEXT,
      hidden_status INTEGER,
      deleted_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE chat_message (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      message_role TEXT,
      message_index INTEGER,
      message_type TEXT,
      is_archived INTEGER DEFAULT 0,
      deleted_at INTEGER DEFAULT 0,
      created_at INTEGER,
      user_message_context TEXT,
      reply_to_message_id TEXT
    );
    CREATE TABLE chat_message_general (
      message_id TEXT PRIMARY KEY,
      content TEXT
    );
  `);

  const T0 = 1789700000; // unix seconds
  db.prepare(
    "INSERT INTO project (project_id, user_id, absolute_path, type, deleted_at) VALUES (?, ?, ?, ?, NULL)",
  ).run("proj-1", "3200014410856620", "E:\\workspace\\tf", "single_root");
  db.prepare(
    "INSERT INTO project (project_id, user_id, absolute_path, type, deleted_at) VALUES (?, ?, ?, ?, NULL)",
  ).run("proj-2", "3200014410856620", "E:\\code\\source\\rmatrix", "single_root");

  // session 1: two projects' first, most recently updated
  const sid1 = (T0 + 60).toString(16) + "0123456789abcdef012345";
  const sid2 = (T0 + 10).toString(16) + "fedcba9876543210fedcba";
  db.prepare(
    "INSERT INTO chat_session (session_id, project_id, session_title, work_mode, hidden_status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, 'work', NULL, 0, ?, ?)",
  ).run(sid1, "proj-1", "帮我分析这个 Vue3 大屏项目", T0 + 60, T0 + 120);
  db.prepare(
    "INSERT INTO chat_session (session_id, project_id, session_title, work_mode, hidden_status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, 'work', NULL, 0, ?, ?)",
  ).run(sid2, "proj-2", "review 当前前后端代码", T0 + 10, T0 + 30);

  const insMsg = db.prepare(
    "INSERT INTO chat_message (session_id, message_id, message_role, message_index, message_type, is_archived, deleted_at, created_at, user_message_context) VALUES (?, ?, ?, ?, 'chat', 0, 0, ?, ?)",
  );
  const insContent = db.prepare(
    "INSERT INTO chat_message_general (message_id, content) VALUES (?, ?)",
  );

  // session 1 messages: user -> assistant (text + tool block) -> user
  insMsg.run(sid1, "m1", "user", 1, T0 + 61, JSON.stringify({ query: "帮我分析这个 Vue3 大屏项目" }));
  insContent.run("m1", JSON.stringify([{ type: "text", text_content: "帮我分析这个 Vue3 大屏项目" }]));
  insMsg.run(sid1, "m2", "assistant", 2, T0 + 62, null);
  insContent.run(
    "m2",
    JSON.stringify([
      { type: "text", text_content: "好的，我先看一下项目结构。" },
      { type: "tool_use", tool: "file_search", arguments: { query: "src" } },
    ]),
  );
  insMsg.run(sid1, "m3", "user", 3, T0 + 63, JSON.stringify({ query: "重点看路由配置" }));
  insContent.run("m3", JSON.stringify([{ type: "text", text_content: "重点看路由配置" }]));

  // session 2 messages (one turn only)
  insMsg.run(sid2, "m4", "user", 1, T0 + 11, JSON.stringify({ query: "review 当前前后端代码" }));
  insContent.run("m4", JSON.stringify([{ type: "text", text_content: "review 当前前后端代码" }]));
  insMsg.run(sid2, "m5", "assistant", 2, T0 + 12, null);
  insContent.run("m5", JSON.stringify([{ type: "text", text_content: "收到，我从目录结构开始。" }]));

  // a deleted message that must NOT appear (inserted with deleted_at=1 so the
  // page never holds free blocks from an UPDATE)
  db.prepare(
    "INSERT INTO chat_message (session_id, message_id, message_role, message_index, message_type, is_archived, deleted_at, created_at, user_message_context) VALUES (?, 'm6', 'user', 4, 'chat', 0, 1, ?, NULL)",
  ).run(sid1, T0 + 64);
  insContent.run("m6", JSON.stringify([{ type: "text", text_content: "应被过滤" }]));

  // compact so no freelist pages survive (they hold stale b-tree bytes that
  // would break the layout transform below)
  db.exec("VACUUM");
  db.close();

  // 2) transform to reserved-80 layout + 3) encrypt
  const plain = readFileSync(plainPath);
  assert.equal(plain.length % PAGE, 0, "plaintext page-aligned");
  const transformed = transformToReservedLayout(plain);
  const key = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);
  const encrypted = encryptAsSqlcipherV4(transformed, key, salt);
  writeFileSync(encPath, encrypted);

  dbDir.plainPath = plainPath;
  dbDir.encPath = encPath;
  dbDir.keyHex = key.toString("hex");
  dbDir.sid1 = sid1;
  dbDir.sid2 = sid2;
  dbDir.T0 = T0;
}

// ---------------------------------------------------------------------------
// sqlcipher-file unit tests
// ---------------------------------------------------------------------------

describe("sqlcipher-file", () => {
  test("verifyKey accepts the right key and rejects wrong ones", async () => {
    await buildFixtureDb();
    const key = Buffer.from(dbDir.keyHex, "hex");
    const page1 = readFileSync(dbDir.encPath).subarray(0, PAGE);
    assert.equal(scFile.verifyKey(page1, key), true);
    assert.equal(scFile.verifyKey(page1, crypto.randomBytes(32)), false);
  });

  test("round-trip: decryptDatabaseFile reproduces the reserved-layout plaintext", () => {
    const plain = readFileSync(dbDir.plainPath);
    const transformed = transformToReservedLayout(Buffer.from(plain));
    const outPath = path.join(tmp, "roundtrip.db");
    const { pages, saltHex } = scFile.decryptDatabaseFile(
      dbDir.encPath,
      dbDir.keyHex,
      outPath,
    );
    assert.equal(pages, transformed.length / PAGE);
    // salt from the fixture
    const salt = readFileSync(dbDir.encPath).subarray(0, 16).toString("hex");
    assert.equal(saltHex, salt);
    // decrypted copy: content region identical, trailing area zeroed
    const out = readFileSync(outPath);
    assert.equal(out.length, transformed.length);
    for (let n = 1; n <= pages; n++) {
      const base = (n - 1) * PAGE;
      const usable = n === 1 ? 4000 : 4016;
      assert.ok(
        out.subarray(base, base + usable).equals(transformed.subarray(base, base + usable)),
        `page ${n} content mismatch`,
      );
      assert.ok(
        out.subarray(base + usable, base + PAGE).every((b) => b === 0),
        `page ${n} trailing bytes not zeroed`,
      );
    }
    // the decrypted copy opens in sqlite and the schema is readable
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(outPath, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) AS c FROM chat_session").all();
    assert.equal(rows[0].c, 2);
    db.close();
  });

  test("passphrase derivation matches SQLCipher v4 PBKDF2-SHA512 256k", () => {
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const pass = Buffer.from("secret-pass", "utf8");
    const key = scFile.deriveKeyFromPassphrase(pass, salt);
    assert.equal(key.length, 32);
    const expected = crypto.pbkdf2Sync(pass, salt, 256000, 32, "sha512");
    assert.ok(key.equals(expected));
  });
});

// ---------------------------------------------------------------------------
// trae-cn adapter end-to-end
// ---------------------------------------------------------------------------

describe("trae-cn adapter", () => {
  test("exports the adapter contract", () => {
    assert.equal(trae.source, "trae-cn");
    assert.ok(trae.label.length > 0);
    assert.equal(typeof trae.scan, "function");
    assert.equal(typeof trae.convert, "function");
    assert.equal(trae.KEY_DOC_PATH, "docs/trae-cn-key.json");
  });

  test("scan() throws the no-key guide when the key doc is missing", async () => {
    trae.setDbPathOverride(dbDir.encPath);
    trae.setKeyProvider(async () => {
      throw new Error("ENOENT");
    });
    await assert.rejects(() => trae.scan(), (err) => {
      assert.match(err.message, /SQLCipher/);
      assert.match(err.message, /trae-cn-key\.json/);
      return true;
    });
    // restore a working provider for the rest of the suite
    trae.setKeyProvider(async () => JSON.stringify({ keyHex: dbDir.keyHex }));
  });

  test("scan() decrypts the fixture and lists sessions (newest first)", async () => {
    const sessions = await trae.scan();
    assert.equal(sessions.length, 2);
    const [first, second] = sessions;
    assert.equal(first.source, "trae-cn");
    assert.equal(first.externalId, dbDir.sid1);
    assert.equal(first.title, "帮我分析这个 Vue3 大屏项目");
    assert.equal(first.projectPath, "E:\\workspace\\tf");
    assert.equal(first.projectName, "tf");
    assert.equal(first.messageCount, 3); // m6 is deleted
    assert.equal(first.createdAt, new Date((dbDir.T0 + 60) * 1000).toISOString());
    assert.equal(first.updatedAt, new Date((dbDir.T0 + 120) * 1000).toISOString());
    assert.equal(second.externalId, dbDir.sid2);
    assert.equal(second.projectName, "rmatrix");
  });

  test("scan() reports an empty list when the database is absent", async () => {
    trae.setDbPathOverride(path.join(tmp, "does-not-exist.db"));
    try {
      const sessions = await trae.scan();
      assert.deepEqual(sessions, []);
    } finally {
      trae.setDbPathOverride(dbDir.encPath);
    }
  });

  test("scan() rejects a wrong key with the re-extract hint", async () => {
    trae.setKeyProvider(async () => JSON.stringify({ keyHex: "00".repeat(32) }));
    try {
      await assert.rejects(() => trae.scan(), (err) =>
        /无法解密/.test(String(err.message)),
      );
    } finally {
      trae.setKeyProvider(async () => JSON.stringify({ keyHex: dbDir.keyHex }));
    }
  });

  test("convert() maps messages, skips deleted ones, keeps tool blocks", async () => {
    const sessions = await trae.scan();
    const s1 = sessions.find((s) => s.externalId === dbDir.sid1);
    const converted = await trae.convert(s1);
    assert.equal(converted.session.id, `import-trae-cn-${dbDir.sid1}`);
    assert.equal(converted.session.title, "帮我分析这个 Vue3 大屏项目");
    assert.equal(converted.session.projectPath, "E:\\workspace\\tf");

    const roles = converted.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "tool", "user"]);
    assert.equal(converted.messages[0].content, "帮我分析这个 Vue3 大屏项目");
    assert.equal(converted.messages[1].content, "好的，我先看一下项目结构。");
    const toolMsg = converted.messages[2];
    assert.equal(toolMsg.toolName, "tool_use");
    assert.equal(toolMsg.toolArgs.tool, "file_search");
    assert.equal(converted.messages[3].content, "重点看路由配置");
    // the deleted m6 turn must not appear
    assert.ok(!converted.messages.some((m) => m.content === "应被过滤"));

    const s2 = sessions.find((s) => s.externalId === dbDir.sid2);
    const c2 = await trae.convert(s2);
    assert.equal(c2.messages.length, 2);
    assert.equal(c2.messages[0].role, "user");
    assert.equal(c2.messages[1].role, "assistant");
  });

  test("user context query is used when the content array is empty", async () => {
    // build a tiny second fixture with a user row whose general content is NULL
    const plainPath = path.join(tmp, "fixture2-plain.db");
    const encPath = path.join(tmp, "fixture2-trae.db");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(plainPath);
    db.exec(`
      PRAGMA page_size = 4096;
      CREATE TABLE project (project_id TEXT PRIMARY KEY, user_id TEXT, absolute_path TEXT, type TEXT, deleted_at INTEGER);
      CREATE TABLE chat_session (id INTEGER PRIMARY KEY, session_id TEXT, project_id TEXT, session_title TEXT, work_mode TEXT, hidden_status INTEGER, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE chat_message (id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, message_role TEXT, message_index INTEGER, message_type TEXT, is_archived INTEGER DEFAULT 0, deleted_at INTEGER DEFAULT 0, created_at INTEGER, user_message_context TEXT, reply_to_message_id TEXT);
      CREATE TABLE chat_message_general (message_id TEXT PRIMARY KEY, content TEXT);
    `);
    const T0 = 1789800000;
    const sid = (T0 + 5).toString(16) + "aaaaaaaaaaaaaaaaaaaaaa";
    db.prepare("INSERT INTO project VALUES ('p1', 'u', 'E:\\ws\\demo', 'single_root', NULL)").run();
    db.prepare(
      "INSERT INTO chat_session (session_id, project_id, session_title, work_mode, hidden_status, deleted_at, created_at, updated_at) VALUES (?, 'p1', 'query-only', 'work', NULL, 0, ?, ?)",
    ).run(sid, T0 + 5, T0 + 6);
    db.prepare(
      "INSERT INTO chat_message (session_id, message_id, message_role, message_index, message_type, is_archived, deleted_at, created_at, user_message_context) VALUES (?, 'q1', 'user', 1, 'chat', 0, 0, ?, ?)",
    ).run(sid, T0 + 5, JSON.stringify({ query: "content 为空时的兜底问题" }));
    db.close();

    const plain = readFileSync(plainPath);
    const transformed = transformToReservedLayout(plain);
    const key = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    writeFileSync(encPath, encryptAsSqlcipherV4(transformed, key, salt));

    trae.setDbPathOverride(encPath);
    trae.setKeyProvider(async () => JSON.stringify({ keyHex: key.toString("hex") }));
    try {
      const sessions = await trae.scan();
      assert.equal(sessions.length, 1);
      const converted = await trae.convert(sessions[0]);
      assert.equal(converted.messages.length, 1);
      assert.equal(converted.messages[0].role, "user");
      assert.equal(converted.messages[0].content, "content 为空时的兜底问题");
    } finally {
      trae.setDbPathOverride(dbDir.encPath);
      trae.setKeyProvider(async () => JSON.stringify({ keyHex: dbDir.keyHex }));
    }
  });

  test("cleanupDecrypted removes the temp copy", async () => {
    await trae.scan();
    await trae.cleanupDecrypted();
    // second scan decrypts again and still works
    const sessions = await trae.scan();
    assert.equal(sessions.length, 2);
    await trae.cleanupDecrypted();
  });

  test("isoFromObjectId decodes the creation second", () => {
    const secs = 1789700000;
    const sid = secs.toString(16) + "0123456789abcdef012345";
    assert.equal(
      trae._internal.isoFromObjectId(sid),
      new Date(secs * 1000).toISOString(),
    );
    assert.equal(trae._internal.isoFromObjectId("short"), null);
  });

  test("no key document -> resolveKey returns null", async () => {
    trae.setKeyProvider(async () => null);
    try {
      assert.equal(await trae._internal.resolveKey(dbDir.encPath), null);
    } finally {
      trae.setKeyProvider(async () => JSON.stringify({ keyHex: dbDir.keyHex }));
    }
  });
});
