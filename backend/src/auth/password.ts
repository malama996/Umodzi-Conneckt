import { argon2id, hash, verify } from 'argon2';

/**
 * Password hashing (Task 23).
 *
 * Argon2id — the memory-hard winner of the Password Hashing Competition —
 * is used with the OWASP-recommended minimum parameters
 * (memoryCost 19456 KiB, timeCost 2, parallelism 1) so verification stays
 * responsive on this prototype host while remaining far beyond brute-force
 * territory. Every call salts independently (argon2 embeds a random salt
 * in the digest), so two identical passwords never share a hash.
 *
 * Rules enforced here:
 *   - plaintext passwords are NEVER logged, returned, or stored;
 *   - only the opaque argon2id digest leaves this module;
 *   - verification failures return false instead of throwing (a malformed
 *     legacy digest must not become a 500 that reveals account state).
 */

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19456, // KiB (OWASP minimum for Argon2id)
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a plaintext password with a fresh random salt (argon2id digest). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Constant-shape verification: true only for the exact password. */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    // Malformed/unknown digest → authentication failure, never a 500.
    return false;
  }
}

/**
 * Timing equalisation for login: when the email is unknown there is no
 * digest to verify against, so verification runs against this throwaway
 * hash instead. The "unknown email" and "wrong password" paths therefore
 * cost the same, and both answer with the identical generic error.
 */
let dummyDigest: Promise<string> | null = null;

export async function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyDigest ??= hashPassword('umodzi-timing-equalisation-dummy');
  return verifyPassword(await dummyDigest, password);
}
