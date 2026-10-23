/**
 * Trae CN adapter: reads the SQLCipher v4 database at
 * %APPDATA%\Trae CN\ModularData\ai-agent\database.db (chat sessions live in
 * chat_session / chat_message / chat_message_general / project).
 *
 * The database is SQLCipher-encrypted (page 4096, reserve 80, PBKDF2-HMAC-
 * SHA512 with 256k iterations; schema reverse-engineered from ai_agent.dll).
 * The key is NOT stored on disk by Trae — it is handed to sea-orm's
 * sqlcipher_key connection option at runtime and wiped from memory when the
 * connection closes (PRAGMA cipher_memory_security). This adapter therefore
 * expects the raw 32-byte key (hex) — or a passphrase — in the workspace file
 * docs/trae-cn-key.json:
 *
 *   { "keyHex": "<64 hex chars>" }
 *   { "passphrase": "<text>" }
 *
 * Use tools/extract-trae-cn-key.ps1 (run it while chatting inside Trae CN)
 * to capture the key once; it is stable across restarts.
 *
 * Decryption rewrites the database into a plaintext SQLite copy that
 * node:sqlite then queries — no b-tree parsing, no native sqlcipher build.
 * Close Trae CN before importing so the WAL is checkpointed; otherwise the
 * last few minutes of chat may be missing (the WAL itself is not decrypted).
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const {
  verifyKey,
  deriveKeyFromPassphrase,
  decryptDatabaseFile,
  removeQuietly,
} = require("../sqlcipher-file");
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "trae-cn";
const KEY_DOC_PATH = "docs/trae-cn-key.json";

const NO_KEY_MESSAGE = [
  "Trae CN 的数据库是 SQLCipher 加密的，还没有配置解密密钥。",
  "一次性配置：1) 保持 Trae CN 运行，执行插件目录下的 tools/extract-trae-cn-key.ps1，",
  "按提示在 Trae CN 的聊天里发一条消息，脚本会把密钥写入临时文件；",
  "2) 把密钥放到工作区 docs/trae-cn-key.json（格式 {\"keyHex\": \"<64位hex>\"}）。",
  "密钥在 Trae 重装/换账号后才会变化，配置一次即可。",
].join("\n");

function appDataDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.getXdgDataDirectory
    ? process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    : path.join(os.homedir(), ".local", "share");
}

const defaultDbPathFor = (home = os.homedir()) =>
  path.join(appDataDir(), "Trae CN", "ModularData", "ai-agent", "database.db");

/** Test/override hook: force the database location. */
let dbPathOverride = null;
function setDbPathOverride(p) {
  dbPathOverride = typeof p === "string" && p ? p : null;
}

const dbPathFor = (home = os.homedir()) => dbPathOverride ?? defaultDbPathFor(home);

/** Host-mediated key file reader; wired by main.js to pi.fs.readText. */
let keyProvider = null;
function setKeyProvider(fn) {
  keyProvider = typeof fn === "function" ? fn : null;
}

async function readKeyDoc() {
  if (!keyProvider) return null;
  let raw;
  try {
    raw = await keyProvider(KEY_DOC_PATH);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" ? parsed : null;
}

/** Resolve the 32-byte AES key for this database (raw key or passphrase). */
async function resolveKey(dbPath) {
  const doc = await readKeyDoc();
  if (!doc) return null;
  if (typeof doc.keyHex === "string" && doc.keyHex.trim()) {
    const key = Buffer.from(doc.keyHex.replace(/^0x/i, "").trim(), "hex");
    if (key.length !== 32) {
      throw new Error("docs/trae-cn-key.json 的 keyHex 必须是 64 位十六进制（32 字节）");
    }
    return key;
  }
  if (typeof doc.passphrase === "string" && doc.passphrase.length > 0) {
    const salt = Buffer.alloc(16);
    const fd = fs.openSync(dbPath, "r");
    try {
      fs.readSync(fd, salt, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    return deriveKeyFromPassphrase(Buffer.from(doc.passphrase, "utf8"), salt);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decrypted-copy cache: one temp copy per source mtime/size, reused across
// scan() and the convertBatch() loop, rebuilt only when the source changes.
// ---------------------------------------------------------------------------

let cache = { sig: null, tempPath: null };

function sourceSig(dbPath) {
  const st = fs.statSync(dbPath);
  return `${st.size}:${st.mtimeMs}:${st.ino ?? 0}`;
}

async function ensureDecrypted(dbPath, key) {
  const sig = sourceSig(dbPath);
  if (cache.sig === sig && cache.tempPath && fs.existsSync(cache.tempPath)) {
    return cache.tempPath;
  }
  if (cache.tempPath) await removeQuietly(cache.tempPath);
  const tempPath = path.join(
    os.tmpdir(),
    `session-import-trae-cn-${process.pid}-${Date.now().toString(36)}.db`,
  );
  decryptDatabaseFile(dbPath, key, tempPath);
  cache = { sig, tempPath };
  return tempPath;
}

async function cleanupDecrypted() {
  if (cache.tempPath) await removeQuietly(cache.tempPath);
  cache = { sig: null, tempPath: null };
}

// ---------------------------------------------------------------------------
// SQL — the schema mirrors the statements recovered from ai_agent.dll.
// ---------------------------------------------------------------------------

const SESSIONS_SQL = `
  SELECT cs.session_id,
         cs.session_title,
         cs.work_mode,
         cs.created_at  AS session_created_at,
         cs.updated_at  AS session_updated_at,
         p.absolute_path AS project_path,
         (SELECT COUNT(*) FROM chat_message m
           WHERE m.session_id = cs.session_id
             AND m.deleted_at = 0
             AND m.is_archived = 0) AS message_count
  FROM chat_session cs
  LEFT JOIN project p ON cs.project_id = p.project_id
  WHERE cs.deleted_at = 0
    AND cs.hidden_status IS NULL
  ORDER BY cs.updated_at DESC, cs.session_id DESC
  LIMIT 5000`;

const MESSAGES_SQL = `
  SELECT cm.message_id,
         cm.message_role,
         cm.message_index,
         cm.created_at,
         cm.user_message_context,
         cmg.content AS general_content
  FROM chat_message cm
  LEFT JOIN chat_message_general cmg ON cmg.message_id = cm.message_id
  WHERE cm.session_id = ?
    AND cm.deleted_at = 0
    AND cm.is_archived = 0
  ORDER BY cm.message_index ASC, cm.id ASC`;

function openSqlite(p) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(p, { readOnly: true });
}

/** Unix SECONDS -> ISO (Trae stores created_at/updated_at as seconds). */
function isoFromSeconds(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
  return null;
}

/** 24-hex ObjectId: the first 8 hex chars encode the Unix creation second. */
function isoFromObjectId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length < 8) return null;
  const secs = parseInt(sessionId.slice(0, 8), 16);
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
}

function parseJsonColumn(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/**
 * chat_message_general.content is a JSON array of blocks; text blocks carry
 * type:"text" + text_content. user_message_context carries $.query for user
 * turns. Non-text blocks (tool calls, images, …) are preserved as tool
 * messages so no content is silently dropped.
 */
function messagePartsFrom(row) {
  const parts = [];
  const blocks = parseJsonColumn(row.general_content);
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text_content === "string") {
        parts.push({ kind: "text", text: block.text_content });
      } else {
        parts.push({ kind: "tool", type: String(block.type ?? "block"), raw: block });
      }
    }
  }
  const userCtx = parseJsonColumn(row.user_message_context);
  const query = userCtx && typeof userCtx.query === "string" ? userCtx.query : null;
  return { parts, query };
}

function toIsoOrNull(value) {
  const iso = isoFromSeconds(value);
  return iso;
}

// ---------------------------------------------------------------------------
// Adapter entry points
// ---------------------------------------------------------------------------

async function scan() {
  const dbPath = dbPathFor();
  let st;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size === 0) return [];

  const key = await resolveKey(dbPath);
  if (!key) throw new Error(NO_KEY_MESSAGE);

  const page1 = Buffer.alloc(4096);
  const fd = fs.openSync(dbPath, "r");
  try {
    fs.readSync(fd, page1, 0, 4096, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!verifyKey(page1, key)) {
    throw new Error(
      "docs/trae-cn-key.json 里的密钥无法解密 Trae CN 的数据库（密钥可能在换号/重装后变了）。请重新运行 tools/extract-trae-cn-key.ps1 提取。",
    );
  }

  const plain = await ensureDecrypted(dbPath, key);
  let db;
  const sessions = [];
  try {
    db = openSqlite(plain);
    const rows = db.prepare(SESSIONS_SQL).all();
    for (const row of rows) {
      if (!row.session_id) continue;
      const title =
        truncateTitle(row.session_title || "") ||
        `Trae CN ${String(row.session_id).slice(-6)}`;
      const createdAt =
        toIsoOrNull(row.session_created_at) || isoFromObjectId(String(row.session_id));
      sessions.push({
        source: SOURCE,
        externalId: String(row.session_id),
        title,
        fullTitle: String(row.session_title ?? ""),
        projectName: projectNameOf(row.project_path) ?? "Trae CN",
        projectPath: row.project_path ?? null,
        modelId: null,
        providerId: null,
        createdAt: createdAt ?? new Date().toISOString(),
        updatedAt: toIsoOrNull(row.session_updated_at) ?? createdAt ?? new Date().toISOString(),
        messageCount: Number(row.message_count ?? 0),
        filePath: dbPath,
      });
    }
  } finally {
    try {
      db && db.close();
    } catch {
      // ignore
    }
  }
  return sessions;
}

async function convert(summary) {
  const dbPath = dbPathFor();
  const key = await resolveKey(dbPath);
  if (!key) throw new Error(NO_KEY_MESSAGE);
  const plain = await ensureDecrypted(dbPath, key);

  let db;
  const messages = [];
  let lastAt = null;
  try {
    db = openSqlite(plain);
    const rows = db.prepare(MESSAGES_SQL).all(summary.externalId);
    for (const row of rows) {
      const createdAt = toIsoOrNull(row.created_at) ?? new Date().toISOString();
      lastAt = createdAt;
      const role = row.message_role === "user" ? "user" : "assistant";
      const { parts, query } = messagePartsFrom(row);
      if (role === "user") {
        const text =
          parts
            .filter((p) => p.kind === "text")
            .map((p) => p.text)
            .join("\n")
            .trim() || query;
        if (text) messages.push({ role: "user", content: text, createdAt });
        for (const p of parts) {
          if (p.kind !== "tool") continue;
          messages.push({
            role: "tool",
            content: JSON.stringify(p.raw),
            createdAt,
            toolName: p.type,
            toolStatus: "success",
            toolArgs: p.raw,
            toolResult: null,
          });
        }
      } else {
        for (const p of parts) {
          if (p.kind === "text") {
            if (p.text.trim()) {
              messages.push({ role: "assistant", content: p.text, createdAt });
            }
          } else {
            messages.push({
              role: "tool",
              content: JSON.stringify(p.raw),
              createdAt,
              toolName: p.type,
              toolStatus: "success",
              toolArgs: p.raw,
              toolResult: null,
            });
          }
        }
      }
    }
  } finally {
    try {
      db && db.close();
    } catch {
      // ignore
    }
  }

  const title =
    truncateTitle(summary.fullTitle || summary.title || "") || summary.title;
  return {
    session: {
      id: `import-trae-cn-${summary.externalId}`,
      title,
      projectPath: summary.projectPath,
      modelId: null,
      providerId: null,
      mode: "agent",
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt || lastAt || summary.createdAt,
    },
    messages,
  };
}

module.exports = {
  source: SOURCE,
  label: "Trae CN",
  dbPathFor,
  KEY_DOC_PATH,
  NO_KEY_MESSAGE,
  setKeyProvider,
  setDbPathOverride,
  scan,
  convert,
  cleanupDecrypted,
  _internal: {
    resolveKey,
    ensureDecrypted,
    isoFromObjectId,
    isoFromSeconds,
    messagePartsFrom,
  },
};
