import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTED_PREFIX = "enc:";

export function credentialEncryptionConfigurationError(): string | null {
  const raw =
    process.env.CREDENTIAL_ENCRYPTION_KEY ?? process.env.WOOCOMMERCE_ENCRYPTION_KEY;
  if (!raw) {
    return "CREDENTIAL_ENCRYPTION_KEY environment variable is not set";
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    return "CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)";
  }
  return null;
}

function getKey(): Buffer {
  // CREDENTIAL_ENCRYPTION_KEY is the canonical name. Fall back to the legacy
  // WOOCOMMERCE_ENCRYPTION_KEY secret so existing encrypted channel credentials
  // remain decryptable without re-keying. Once the secret is renamed to
  // CREDENTIAL_ENCRYPTION_KEY (same value), the fallback can be removed.
  const raw =
    process.env.CREDENTIAL_ENCRYPTION_KEY ?? process.env.WOOCOMMERCE_ENCRYPTION_KEY;
  const configurationError = credentialEncryptionConfigurationError();
  if (configurationError) throw new Error(configurationError);
  const buf = Buffer.from(raw!, "hex");
  return buf;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a compact string: "enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a value produced by `encrypt`.
 * Throws if the value is malformed or authentication fails.
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  const inner = encrypted.slice(ENCRYPTED_PREFIX.length);
  const parts = inner.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credential — expected enc:<iv>:<tag>:<ciphertext>");
  }
  const [ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Returns true when the stored value looks like it was produced by `encrypt`.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Transparently decrypt a credential that may be either already-encrypted
 * or still stored as plaintext (migration path).
 *
 * When a plaintext value is detected, `onMigrate` is called so the caller can
 * persist the newly-encrypted form back to the database.
 */
export async function decryptCredential(
  value: string,
  onMigrate?: (encrypted: string) => Promise<void>,
): Promise<string> {
  if (isEncrypted(value)) {
    return decrypt(value);
  }

  logger.warn("Credential stored as plaintext — migrating to encrypted form");
  const encrypted = encrypt(value);
  if (onMigrate) {
    try {
      await onMigrate(encrypted);
    } catch (err) {
      logger.error({ err }, "Failed to persist migrated credential");
    }
  }
  return value;
}
