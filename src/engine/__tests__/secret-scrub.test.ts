import { describe, expect, it } from "vitest";
import { REDACTED, scrubSecrets } from "../secret-scrub.js";

const cases: Array<[string, string]> = [
  ["sk-abcdefghijklmnop", REDACTED],
  ["sk-proj-abcdefghijklmnop_1234", REDACTED],
  ["sk_live_1234567890abcdefgh", REDACTED],
  ["pk_test_1234567890abcdefgh", REDACTED],
  ["rk_live_1234567890abcdefgh", REDACTED],
  ["AKIAIOSFODNN7EXAMPLE", REDACTED],
  ["ghp_abcdefghijklmnopqrstuvwxyz", REDACTED],
  ["github_pat_abcdefghijklmnopqrstuvwxyz", REDACTED],
  ["AIza" + "a".repeat(35), REDACTED],
  ["xoxb-1234567890-abcdefghijkl", REDACTED],
  ["eyJabcdefghijk.abcdefghijkl.abcdefghijkl", REDACTED],
  ["-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----", REDACTED],
  ["password: hunter2secret", "password: [REDACTED]"],
  ["Bearer abcdef123456", "Bearer [REDACTED]"],
  ['api_key = "abc12345"', 'api_key = "[REDACTED]"'],
  ["verification code: 123 456", "verification code: [REDACTED]"],
  ["OTP: 12-34-56", "OTP: [REDACTED]"],
  ["123-45-6789", REDACTED],
  ["4111 1111 1111 1111", REDACTED],
  ["4111111111111111", REDACTED],
  ["token: null", "token: null"],
  ["password: false", "password: false"],
  ["token: undefined", "token: undefined"],
  ["password: [REDACTED]", "password: [REDACTED]"],
  ["7b3a098dc451f087ef1244bd93805137b9e011f4", "7b3a098dc451f087ef1244bd93805137b9e011f4"],
  ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174000"],
  ["v12.3.4 port 8080 year 202601 /src/auth.ts", "v12.3.4 port 8080 year 202601 /src/auth.ts"],
  ["1234567890123", "1234567890123"],
  ["4111111111111112", "4111111111111112"],
  ["sk-short api_key=short", "sk-short api_key=short"],
  ["", ""],
];

describe("the pinned deterministic scrubber", () => {
  it.each(cases)("scrubs structured secrets and preserves non-secrets: %s", (input, expected) => {
    expect(scrubSecrets(input)).toBe(expected);
    expect(scrubSecrets(scrubSecrets(input))).toBe(expected);
  });

  it("redacts every occurrence and resets global regex state across calls", () => {
    const input = "before sk-abcdefghijklmnop after sk-abcdefghijklmnop";
    for (let i = 0; i < 3; i++) {
      expect(scrubSecrets(input)).toBe("before [REDACTED] after [REDACTED]");
    }
  });
});
