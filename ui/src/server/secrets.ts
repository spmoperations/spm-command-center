// Keys and tokens are encrypted before they are written to the database (AES-256-GCM).
// The encryption key comes from the SECRETS_KEY environment variable and is never stored
// next to the data it protects.
import crypto from "node:crypto";

function key(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) throw new Error("SECRETS_KEY is not set. Add a 32-byte base64 key to .env.local (openssl rand -base64 32).");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded.");
  return bytes;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function unseal(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Stored secret is not in a format this version can read.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
