/**
 * Codely CLI adapter: reads ~/.codely-cli/tmp/<sha256(cwd)>/chats/<sessionId>.jsonl
 * (durable session transcripts written by the Codely CLI agent).
 *
 * Format (verified against a real 1.7 GB / 303-file tree on Windows):
 *   {"t":"header","v":1,"seq":0,"durableSessionId":"…","projectHash":"…","startedAt":"…ISO…"}
 *   {"t":"put","seq":N,"msg":{"id":"…","timestamp":"…","type":"user|gemini","content":"…"|[{text}],"model":"…"}}
 *   {"t":"ckpt","seq":N,"msgCount":N,"lastUpdated":"…","title":"…"}
 *   {"t":"session",…} / {"t":"handoff",…}  — ignored
 *   - msg.type "gemini" is the assistant; "session_snapshot"/"task_notification" carry
 *     attachmentMeta.isMeta:true and are skipped.
 *   - The same msg.id is rewritten on streaming updates: keep the LAST content,
 *     but order by first appearance.
 *   - projectHash is SHA256 of the raw cwd string, so ~/.codely/recent-projects.json
 *     paths can be hashed back to recover the project path; the CLI also injects a
 *     bootstrap user message ("This is the Codely CLI … currently working in the
 *     directory: <path>") we can parse as a fallback.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { toIso, truncateTitle, projectNameOf, mapValuesWithConcurrency } = require("../util");

const SOURCE = "codely-cli";

const tmpDirFor = (home = os.homedir()) => path.join(home, ".codely-cli", "tmp");
const recentProjectsPath = (home = os.homedir()) => path.join(home, ".codely", "recent-projects.json");

// How many chat files to stream at once during a scan.
const SCAN_CONCURRENCY = 12;
// Stop streaming a transcript head once the list row has everything it needs.
const SCAN_HEAD_ITEMS = 40;
// Progressive scan budget (mirrors the Codex adapter contract in main.js).
const SCAN_FAST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SCAN_FAST_MAX_FILES = 120;
const SCAN_FAST_MAX_BYTES = 96 * 1024 * 1024;

const isMetaMsg = (msg) => msg?.attachmentMeta?.isMeta === true;
const isConversationMsg = (msg) =>
  !!msg &&
  (msg.type === "user" || msg.type === "gemini") &&
  !isMetaMsg(msg);

function msgText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => typeof c?.text === "string" && c.thought !== true)
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// The CLI's first user message is a synthetic bootstrap ("This is the Codely
// CLI… I'm currently working in the directory: E:\…") — real for cwd recovery,
// noise as a title / imported user turn.
function isBootstrapUserText(text) {
  return /^this is the codely cli/i.test(text);
}

/** Extract the cwd the CLI prints in its bootstrap user message. */
function cwdFromBootstrap(text) {
  if (!text) return null;
  for (const line of String(text).split(/\r?\n/)) {
    const idx = line.toLowerCase().lastIndexOf("directory:");
    if (idx === -1) continue;
    let cand = line.slice(idx + "directory:".length).trim();
    // The path is followed by prose ("… let me know …") on the same line only
    // sometimes; when it is, the line usually ends right after the path.
    cand = cand.replace(/\s*\.{3,}\s*$/, "").trim();
    if (/^[A-Za-z]:[\\/]/.test(cand) || /^\/[^/]/.test(cand)) {
      return cand.replace(/[.。,;，]+$/, "") || null;
    }
  }
  return null;
}

/**
 * Streaming line reader shared with the Claude/Codex adapters: keeps peak
 * memory at one line and lets the caller abort a multi-MB transcript early.
 */
async function streamLines(filePath, onLine, shouldStop) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const counter = { lines: 0, items: 0 };
  try {
    for await (const line of rl) {
      counter.lines += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      onLine(parsed, counter);
      if (shouldStop && shouldStop(counter)) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return counter;
}

/** Walk tmp/<projectHash>/chats/*.jsonl and stat every transcript. */
async function listSessionEntries(rootDir) {
  const paths = [];
  let projectDirs = [];
  try {
    projectDirs = await fsp.readdir(rootDir);
  } catch {
    return [];
  }
  for (const dir of projectDirs) {
    const chatsDir = path.join(rootDir, dir, "chats");
    let files = [];
    try {
      files = await fsp.readdir(chatsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl")) paths.push(path.join(chatsDir, file));
    }
  }
  const stated = await mapValuesWithConcurrency(paths, SCAN_CONCURRENCY, async (filePath) => {
    try {
      const info = await fsp.stat(filePath);
      if (!info.isFile() || info.size === 0) return null;
      return { filePath, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  });
  return stated.filter(Boolean);
}

function selectFiles(entries, { maxFiles, maxBytes, sinceMs }) {
  let candidates = entries;
  if (sinceMs) {
    const recent = entries.filter((e) => e.mtimeMs >= sinceMs);
    if (recent.length > 0) candidates = recent;
  }
  if (typeof maxFiles === "number" && candidates.length > maxFiles) {
    candidates = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
  }
  if (typeof maxBytes === "number") {
    const kept = [];
    let bytes = 0;
    for (const entry of candidates) {
      if (bytes + entry.size > maxBytes && kept.length > 0) continue;
      bytes += entry.size;
      kept.push(entry);
    }
    return kept;
  }
  return candidates;
}

/**
 * Recover the project path for a projectHash directory by hashing every path
 * recorded in ~/.codely/recent-projects.json (the hash is SHA256 of the raw
 * cwd string, verified against a real tree). Missing/unparsable file → null.
 */
async function projectPathForHash(hash, home = os.homedir()) {
  if (!hash) return null;
  let raw;
  try {
    raw = await fsp.readFile(recentProjectsPath(home), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const paths = [];
  const walk = (node, depth) => {
    if (node == null || depth > 4) return;
    if (typeof node === "string") {
      paths.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };
  walk(parsed, 0);
  for (const candidate of paths) {
    try {
      const digest = crypto.createHash("sha256").update(String(candidate), "utf8").digest("hex");
      if (digest === String(hash).toLowerCase()) return candidate;
    } catch {
      // skip unreadable candidate
    }
  }
  return null;
}

/** Parse the head of one transcript into a list row's worth of metadata. */
async function scanFileMetadata(filePath, projectHashFromDir) {
  let externalId = "";
  let startedAt = null;
  let lastAt = null;
  let lastTitle = "";
  let firstUser = null;
  let bootstrapText = null;
  let messageCount = 0;
  let lastMsgCount = 0;
  let model = null;

  const stop = (counter) =>
    (!!firstUser || !!lastTitle) && counter.items >= SCAN_HEAD_ITEMS;

  try {
    await streamLines(
      filePath,
      (obj, counter) => {
        if (obj.t === "header") {
          externalId = obj.durableSessionId ?? externalId;
          startedAt = obj.startedAt ?? startedAt;
          return;
        }
        if (obj.t === "ckpt") {
          if (obj.title) lastTitle = String(obj.title);
          if (obj.lastUpdated) lastAt = obj.lastUpdated;
          if (typeof obj.msgCount === "number") lastMsgCount = obj.msgCount;
          return;
        }
        if (obj.t !== "put" || !isConversationMsg(obj.msg)) return;
        counter.items += 1;
        const msg = obj.msg;
        if (msg.timestamp) lastAt = msg.timestamp;
        if (msg.type === "gemini") {
          if (msg.model) model = msg.model;
          messageCount += 1;
          return;
        }
        // user
        messageCount += 1;
        const text = msgText(msg);
        if (!text) return;
        if (isBootstrapUserText(text)) {
          if (bootstrapText == null) bootstrapText = text;
          return;
        }
        if (firstUser == null) firstUser = text;
      },
      stop,
    );
  } catch {
    return null; // unreadable — skip
  }

  if (!externalId) externalId = path.basename(filePath, ".jsonl");
  if (messageCount === 0) return null;
  return {
    externalId,
    projectHashFromDir,
    startedAt,
    lastAt,
    lastTitle,
    firstUser,
    bootstrapText,
    messageCount: lastMsgCount || messageCount,
    model,
  };
}

async function mapSessions(entries, home) {
  const results = await mapValuesWithConcurrency(entries, SCAN_CONCURRENCY, async (entry) => {
    const filePath = entry.filePath ?? entry;
    const projectHashFromDir = path.basename(path.dirname(path.dirname(filePath)));
    const meta = await scanFileMetadata(filePath, projectHashFromDir);
    if (!meta) return null;
    const cwd = cwdFromBootstrap(meta.bootstrapText) ?? (await projectPathForHash(projectHashFromDir, home));
    const title =
      truncateTitle(meta.lastTitle || meta.firstUser || "") || meta.externalId;
    return {
      source: SOURCE,
      externalId: meta.externalId,
      title,
      fullTitle: meta.lastTitle || meta.firstUser || "",
      projectName: projectNameOf(cwd) ?? "Codely CLI",
      projectPath: cwd,
      modelId: meta.model,
      providerId: null,
      createdAt: toIso(meta.startedAt),
      updatedAt: toIso(meta.lastAt, toIso(meta.startedAt)),
      messageCount: meta.messageCount,
      filePath,
    };
  });
  const sessions = results.filter(Boolean);
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

/** First pass: recent transcripts, bounded in files and bytes. */
async function scanFast() {
  const entries = await listSessionEntries(tmpDirFor());
  const picked = selectFiles(entries, {
    maxFiles: SCAN_FAST_MAX_FILES,
    maxBytes: SCAN_FAST_MAX_BYTES,
    sinceMs: Date.now() - SCAN_FAST_WINDOW_MS,
  });
  return mapSessions(picked, os.homedir());
}

/** Full pass: every chat transcript under ~/.codely-cli/tmp. */
async function scan() {
  const entries = await listSessionEntries(tmpDirFor());
  return mapSessions(entries, os.homedir());
}

/** Tool result text from a Codely toolCalls[] entry. */
function toolResultText(call) {
  const output =
    call?.result?.functionResponse?.response?.output ??
    call?.result?.output ??
    null;
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

async function parseFile(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const header = { externalId: "", startedAt: null };
  // msg.id → { msg (last occurrence), firstTs } — streaming updates rewrite the
  // same id, so last content wins while ordering keeps first appearance.
  const byId = new Map();
  const order = [];
  let lastAt = null;
  let lastTitle = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.t === "header") {
      header.externalId = obj.durableSessionId ?? header.externalId;
      header.startedAt = obj.startedAt ?? header.startedAt;
    } else if (obj.t === "ckpt") {
      if (obj.title) lastTitle = String(obj.title);
      if (obj.lastUpdated) lastAt = obj.lastUpdated;
    } else if (obj.t === "put" && isConversationMsg(obj.msg)) {
      const msg = obj.msg;
      if (msg.timestamp) lastAt = msg.timestamp;
      const existing = byId.get(msg.id);
      if (existing) {
        existing.msg = msg;
      } else {
        byId.set(msg.id, { msg, firstTs: msg.timestamp ?? null });
        if (msg.id) order.push(msg.id);
      }
    }
  }
  const messages = [];
  for (const id of order) {
    const entry = byId.get(id);
    const msg = entry.msg;
    const createdAt = toIso(msg.timestamp ?? entry.firstTs, undefined);
    const text = msgText(msg);
    if (msg.type === "user") {
      if (text && !isBootstrapUserText(text)) {
        messages.push({ role: "user", content: text, createdAt });
      }
      continue;
    }
    // assistant ("gemini")
    if (text) messages.push({ role: "assistant", content: text, createdAt });
    for (const call of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
      const resultText = toolResultText(call);
      messages.push({
        role: "tool",
        content: resultText,
        createdAt: toIso(call?.timestamp ?? msg.timestamp, createdAt),
        toolName: call?.name ?? "tool",
        toolCallId: call?.id ?? undefined,
        toolStatus: call?.status === "error" ? "error" : "success",
        toolArgs: call?.args ?? null,
        toolResult: resultText,
      });
    }
  }
  return {
    externalId: header.externalId || path.basename(filePath, ".jsonl"),
    startedAt: header.startedAt,
    lastAt,
    lastTitle,
    messages,
  };
}

async function convert(summary) {
  const parsed = await parseFile(summary.filePath);
  const messages = parsed?.messages ?? [];
  const title =
    truncateTitle(parsed?.lastTitle || summary.fullTitle || "") ||
    summary.title;
  return {
    session: {
      id: `import-codely-cli-${summary.externalId}`,
      title,
      projectPath: summary.projectPath,
      modelId: summary.modelId,
      providerId: null,
      mode: "agent",
      createdAt: toIso(parsed?.startedAt, summary.createdAt),
      updatedAt: toIso(parsed?.lastAt, summary.updatedAt),
    },
    messages,
  };
}

module.exports = {
  source: SOURCE,
  label: "Codely CLI",
  tmpDirFor,
  recentProjectsPath,
  cwdFromBootstrap,
  projectPathForHash,
  scan,
  scanFast,
  convert,
};
