/**
 * Encryption for off-site (rclone) backup copies.
 *
 * Archives hold app configs, secrets and full SQL dumps, so copies that leave
 * the machine are encrypted with AES-256-GCM before upload. The key is derived
 * (HKDF-SHA256) from TALOME_SECRET — the same secret that already protects
 * Talome's encrypted settings, so keeping `.env` safe is enough to read the
 * copies back on a new machine.
 *
 * File format:  "TLMBKE1\0" (8) | IV (12) | ciphertext | GCM tag (16)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export const ENCRYPTED_SUFFIX = ".enc";
const MAGIC = Buffer.from("TLMBKE1\0", "binary");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

function offsiteKey(): Buffer {
  const secret = process.env.TALOME_SECRET;
  if (!secret) throw new Error("TALOME_SECRET is required to encrypt off-site backup copies");
  return Buffer.from(hkdfSync("sha256", secret, "talome-backup-offsite", "archive-v1", 32));
}

/** Encrypt `src` into `dest` (streaming). */
export async function encryptFile(src: string, dest: string): Promise<void> {
  const key = offsiteKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  try {
    await writeFile(dest, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
    await pipeline(createReadStream(src), cipher, createWriteStream(dest, { flags: "a" }));
    await appendFile(dest, cipher.getAuthTag());
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}

/** True when the file starts with the off-site encryption header. */
export async function isEncryptedFile(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, MAGIC.length, 0);
    return bytesRead === MAGIC.length && buf.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

/** Decrypt `src` into `dest`. Throws (and removes `dest`) when the file was tampered with. */
export async function decryptFile(src: string, dest: string): Promise<void> {
  const size = (await stat(src)).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error("Encrypted backup file is truncated");
  const fh = await open(src, "r");
  let header: Buffer;
  let tag: Buffer;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    await fh.read(header, 0, HEADER_BYTES, 0);
    tag = Buffer.alloc(TAG_BYTES);
    await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not an encrypted Talome backup file");
  const decipher = createDecipheriv("aes-256-gcm", offsiteKey(), header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  try {
    const body =
      size - TAG_BYTES > HEADER_BYTES
        ? createReadStream(src, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 })
        : (async function* () {})();
    await pipeline(body, decipher, createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    throw new Error(`Cannot decrypt backup copy (wrong TALOME_SECRET or tampered file): ${err instanceof Error ? err.message : String(err)}`);
  }
}
