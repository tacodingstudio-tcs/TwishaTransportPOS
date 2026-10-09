// apps/api/src/lib/password.ts
//
// THE ONLY place PIN hashing happens in the entire codebase.
// Previously, auth.ts, tenants.ts, and seed.ts each called
// crypto.createHash('sha256') independently — a fast hash that is
// trivially brute-forceable against a 4-digit PIN (10,000 possibilities
// hash in well under a second on any modern machine, even slower SHA-256).
//
// bcrypt is deliberately slow (tunable via cost factor) which makes
// brute-forcing computationally expensive even at scale. Combined with
// the login rate limiter in routes/auth.ts, this closes the PIN-guessing
// attack surface from two directions: slow hashing + capped attempts.

import bcrypt from 'bcrypt'

// Cost factor 10 = ~65ms per hash on typical server hardware.
// High enough to make brute-forcing impractical, low enough to not
// slow down legitimate logins noticeably. Re-evaluate upward (11-12)
// as server hardware improves — bcrypt cost should rise over time.
const SALT_ROUNDS = 10

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS)
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash)
}
