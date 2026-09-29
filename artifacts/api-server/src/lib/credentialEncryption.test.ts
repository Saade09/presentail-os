import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { encrypt, decrypt, isEncrypted, decryptCredential } from "./credentialEncryption";

const VALID_KEY = "a".repeat(64);

// ---------------------------------------------------------------------------
// encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe("encrypt() and decrypt() — round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const plaintext = "ck_abc123secret";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertext on each call (random IV)", () => {
    const plaintext = "same-value";
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    expect(enc1).not.toBe(enc2);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips a string with special characters", () => {
    const special = "cs_live_&secret=value+plus/equals==";
    expect(decrypt(encrypt(special))).toBe(special);
  });
});

// ---------------------------------------------------------------------------
// encrypt() — missing or invalid key
// ---------------------------------------------------------------------------

describe("encrypt() — key validation", () => {
  const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  it("throws when CREDENTIAL_ENCRYPTION_KEY is not set", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encrypt("anything")).toThrow("CREDENTIAL_ENCRYPTION_KEY environment variable is not set");
  });

  it("throws when the key is too short (not 64 hex chars)", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "deadbeef";
    expect(() => encrypt("anything")).toThrow("64-character hex string");
  });
});

// ---------------------------------------------------------------------------
// decrypt() — malformed input
// ---------------------------------------------------------------------------

describe("decrypt() — malformed input", () => {
  it("throws on input missing the enc: prefix (wrong number of parts)", () => {
    expect(() => decrypt("enc:onlytwoparts")).toThrow("Malformed encrypted credential");
  });

  it("throws on tampered auth tag (GCM authentication failure)", () => {
    const encrypted = encrypt("hello");
    const parts = encrypted.split(":");
    parts[2] = parts[2].replace(/[0-9a-f]/, (c) => (parseInt(c, 16) ^ 0xf).toString(16));
    const tampered = parts.join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when called without the enc: prefix", () => {
    expect(() => decrypt("plaintext-value")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isEncrypted()
// ---------------------------------------------------------------------------

describe("isEncrypted()", () => {
  it("returns true for a value produced by encrypt()", () => {
    expect(isEncrypted(encrypt("secret"))).toBe(true);
  });

  it("returns true for a string manually prefixed with enc:", () => {
    expect(isEncrypted("enc:anything")).toBe(true);
  });

  it("returns false for a plaintext value", () => {
    expect(isEncrypted("ck_live_someconsumerkey")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isEncrypted("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decryptCredential() — already-encrypted path
// ---------------------------------------------------------------------------

describe("decryptCredential() — already-encrypted value", () => {
  it("decrypts the value and does NOT call onMigrate", async () => {
    const plaintext = "cs_secret_value";
    const encrypted = encrypt(plaintext);
    const onMigrate = vi.fn();

    const result = await decryptCredential(encrypted, onMigrate);

    expect(result).toBe(plaintext);
    expect(onMigrate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// decryptCredential() — plaintext migration path
// ---------------------------------------------------------------------------

describe("decryptCredential() — plaintext value (migration)", () => {
  it("returns the original plaintext and calls onMigrate with the encrypted form", async () => {
    const plaintext = "ck_plaintext_key";
    const onMigrate = vi.fn().mockResolvedValue(undefined);

    const result = await decryptCredential(plaintext, onMigrate);

    expect(result).toBe(plaintext);
    expect(onMigrate).toHaveBeenCalledOnce();

    const migratedArg: string = onMigrate.mock.calls[0][0];
    expect(isEncrypted(migratedArg)).toBe(true);
    expect(decrypt(migratedArg)).toBe(plaintext);
  });

  it("still returns the plaintext even when onMigrate throws", async () => {
    const plaintext = "ck_plaintext_key_failing_migrate";
    const onMigrate = vi.fn().mockRejectedValue(new Error("DB unavailable"));

    const result = await decryptCredential(plaintext, onMigrate);

    expect(result).toBe(plaintext);
    expect(onMigrate).toHaveBeenCalledOnce();
  });

  it("works without an onMigrate callback", async () => {
    const plaintext = "ck_no_callback";
    const result = await decryptCredential(plaintext);
    expect(result).toBe(plaintext);
  });
});
