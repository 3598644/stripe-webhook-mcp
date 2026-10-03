import { describe, expect, it } from "vitest";
import { loadConfig, requireStripeKey } from "../src/config.js";

describe("requireStripeKey", () => {
  it("accepts test keys", () => {
    expect(requireStripeKey(loadConfig({ STRIPE_SECRET_KEY: "sk_test_abc" }), {})).toBe("sk_test_abc");
    expect(requireStripeKey(loadConfig({ STRIPE_SECRET_KEY: "rk_test_abc" }), {})).toBe("rk_test_abc");
  });

  it("refuses live keys unless explicitly allowed", () => {
    const config = loadConfig({ STRIPE_SECRET_KEY: "sk_live_abc" });
    expect(() => requireStripeKey(config, {})).toThrow(/live-mode/);
    expect(requireStripeKey(config, { STRIPE_WEBHOOK_MCP_ALLOW_LIVE: "1" })).toBe("sk_live_abc");
  });

  it("explains a missing key", () => {
    expect(() => requireStripeKey(loadConfig({}), {})).toThrow(/STRIPE_SECRET_KEY is not set/);
  });
});
