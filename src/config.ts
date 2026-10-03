import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  stripeSecretKey: string | undefined;
  webhookSecret: string | undefined;
  targetUrl: string | undefined;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    stripeSecretKey: env.STRIPE_SECRET_KEY || undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    targetUrl: env.WEBHOOK_TARGET_URL || undefined,
    dbPath: env.STRIPE_WEBHOOK_MCP_DB || join(homedir(), ".stripe-webhook-mcp", "events.db"),
  };
}

/**
 * Returns the key, or throws an error written for the agent to relay. Live
 * keys are refused unless explicitly allowed: this is a dev-loop tool, and an
 * agent replaying live events into a local handler is a footgun.
 */
export function requireStripeKey(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const key = config.stripeSecretKey;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. Use a test-mode secret or restricted key (sk_test_... or rk_test_...).");
  }
  if (/^(sk|rk)_live_/.test(key) && env.STRIPE_WEBHOOK_MCP_ALLOW_LIVE !== "1") {
    throw new Error(
      "Refusing to use a live-mode Stripe key. Use a test-mode key, or set STRIPE_WEBHOOK_MCP_ALLOW_LIVE=1 if you really mean it.",
    );
  }
  return key;
}

export function requireWebhookSecret(config: Config, override?: string): string {
  const secret = override ?? config.webhookSecret;
  if (!secret) {
    throw new Error(
      "No webhook signing secret. Set STRIPE_WEBHOOK_SECRET to your endpoint's whsec_... value (the same one your handler verifies with).",
    );
  }
  return secret;
}

export function requireTargetUrl(config: Config, override?: string): string {
  const url = override ?? config.targetUrl;
  if (!url) {
    throw new Error("No target URL. Pass one (e.g. http://localhost:3000/api/webhooks/stripe) or set WEBHOOK_TARGET_URL.");
  }
  return url;
}
