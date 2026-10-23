/**
 * Minimal SQLCipher v4 file decryptor: turns an encrypted database into a
 * plaintext SQLite file that node:sqlite can open directly.
 *
 * Confirmed layout for Trae CN's ai-agent database.db (page 1 header inside
 * RAM): page size 4096, reserved 80 bytes (IV 16 + HMAC-SHA512 64), salt in
 * the first 16 bytes of page 1, ciphertext starting at offset 16 on page 1
 * and offset 0 everywhere else, AES-256-CBC per page with the IV stored at
 * (pageSize - reserve).
 *
 * The plaintext page is rebuilt as: decrypted content + zero padding to the
 * full page size. SQLite reads the reserved-bytes figure from the decrypted
 * header (byte 20 = 80) and ignores the trailing region, so the padded copy
 * is a fully valid database for node:sqlite.
 */
"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const { createHash } = crypto;

const PAGE_SIZE = 4096;
const RESERVE = 80;
const IV_OFFSET = PAGE_SIZE - RESERVE;

/**
 * Verify a candidate 32-byte key against page 1 of the encrypted file.
 * Returns true when the page decrypts to the SQLite header.
 */
function verifyKey(encryptedPage1, key) {
  try {
    const iv = encryptedPage1.subarray(IV_OFFSET, IV_OFFSET + 16);
    const d = crypto.createDecipheriv("aes-256-cbc", key, iv);
    d.setAutoPadding(false);
    const out = d.update(encryptedPage1.subarray(16, 32));
    const head = Buffer.concat([out, d.final()]);
    // "SQLite format " is 14 characters; page 1 decrypts to "SQLite format 3\0"
    return head.subarray(0, 14).toString("latin1") === "SQLite format ";
  } catch {
    return false;
  }
}

/** Derive the AES-256 key from a passphrase with SQLCipher v4 defaults. */
function deriveKeyFromPassphrase(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 256000, 32, "sha512");
}

/** Derive the HMAC key (kept for completeness; verification uses AES only). */
function deriveHmacKeyFromPassphrase(passphrase, salt) {
  const hmacSalt = Buffer.from(salt);
  for (let i = 0; i < hmacSalt.length; i++) hmacSalt[i] ^= 0x3a;
  return crypto.pbkdf2Sync(passphrase, hmacSalt, 2, 32, "sha512");
}

/**
 * Decrypt an encrypted SQLCipher v4 database into a plaintext SQLite file.
 * @param {string} encryptedPath source database
 * @param {Buffer|string} key 32-byte raw AES key (Buffer) or hex string
 * @param {string} outPath where the plaintext copy is written
 * @returns {{pages:number, saltHex:string}}
 */
function decryptDatabaseFile(encryptedPath, key, outPath) {
  const rawKey = Buffer.isBuffer(key)
    ? key
    : Buffer.from(String(key).replace(/^0x/i, "").trim(), "hex");
  if (rawKey.length !== 32) {
    throw new Error(`SQLCipher key must be 32 bytes (got ${rawKey.length})`);
  }

  const stat = fs.statSync(encryptedPath);
  if (stat.size < PAGE_SIZE) {
    throw new Error(`database too small: ${stat.size} bytes`);
  }
  const pageCount = Math.floor(stat.size / PAGE_SIZE);
  if (pageCount * PAGE_SIZE !== stat.size) {
    throw new Error(`database size ${stat.size} is not a multiple of ${PAGE_SIZE}`);
  }

  const fd = fs.openSync(encryptedPath, "r");
  const out = fs.openSync(outPath, "w");
  try {
    const page = Buffer.alloc(PAGE_SIZE);
    const plain = Buffer.alloc(PAGE_SIZE);
    for (let n = 1; n <= pageCount; n++) {
      fs.readSync(fd, page, 0, PAGE_SIZE, (n - 1) * PAGE_SIZE);
      const iv = page.subarray(IV_OFFSET, IV_OFFSET + 16);
      const ctStart = n === 1 ? 16 : 0;
      const ct = page.subarray(ctStart, IV_OFFSET);
      if (ct.length % 16 !== 0) {
        throw new Error(`page ${n}: ciphertext not block aligned (${ct.length})`);
      }
      const d = crypto.createDecipheriv("aes-256-cbc", rawKey, iv);
      d.setAutoPadding(false);
      const pt = d.update(ct);
      d.final();
      plain.fill(0);
      pt.copy(plain, 0);
      fs.writeSync(out, plain, 0, PAGE_SIZE);
    }
    const salt = Buffer.alloc(16);
    fs.readSync(fd, salt, 0, 16, 0);
    return { pages: pageCount, saltHex: salt.toString("hex") };
  } finally {
    fs.closeSync(fd);
    fs.closeSync(out);
  }
}

/** Best-effort async removal used by the adapters after importing. */
async function removeQuietly(p) {
  try {
    await fsp.rm(p, { force: true });
  } catch {
    // ignore
  }
}

/** SHA-256 of a file, used to fingerprint decrypted temp copies. */
async function sha256File(p) {
  const buf = await fsp.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

module.exports = {
  PAGE_SIZE,
  RESERVE,
  IV_OFFSET,
  verifyKey,
  deriveKeyFromPassphrase,
  deriveHmacKeyFromPassphrase,
  decryptDatabaseFile,
  removeQuietly,
  sha256File,
};
