import crypto from "node:crypto";
// 6-digit code, cryptographically random, always 6 chars (100000–999999).
export function generateOtpCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
