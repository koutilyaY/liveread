import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB (OWASP recommended baseline)
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** URL-safe, cryptographically random identifier (default 128 bits). */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** Tokens are stored only as SHA-256 hashes. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Privacy-preserving IP hash (per-day salt would be better in production). */
export function ipHash(ip: string | undefined, secret: string): string | null {
  if (!ip) return null;
  return createHash("sha256")
    .update(`${secret}:${ip}`)
    .digest("hex")
    .slice(0, 32);
}

export function userAgentFamily(ua: string | undefined): string | null {
  if (!ua) return null;
  if (/firefox/i.test(ua)) return "firefox";
  if (/edg/i.test(ua)) return "edge";
  if (/chrome|crios/i.test(ua)) return "chrome";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}
