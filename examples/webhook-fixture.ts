/**
 * A minimal Stripe webhook handler to dogfood stripe-webhook-mcp against.
 *
 *   STRIPE_WEBHOOK_SECRET=whsec_test npm run fixture
 *   # handler at http://localhost:3000/webhook
 *
 * It verifies signatures exactly like a production handler, and contains one
 * deliberate, realistic bug (see `invoice.paid`) so there's something for an
 * agent to find with replay_event.
 */
import { createServer } from "node:http";
import Stripe from "stripe";

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set STRIPE_WEBHOOK_SECRET (any whsec_... value; use the same one for stripe-webhook-mcp).");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(body, req.headers["stripe-signature"] ?? "", secret);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Signature verification failed: ${(err as Error).message}`);
    return;
  }

  try {
    handle(event);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ received: true }));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" }).end((err as Error).stack);
  }
});

function handle(event: Stripe.Event): void {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      console.log(`checkout completed: ${session.id} for ${session.customer_details?.email ?? "unknown"}`);
      break;
    }
    case "invoice.paid": {
      // DELIBERATE BUG: since API version 2025-03-31 the subscription moved to
      // invoice.parent.subscription_details.subscription, and older payloads
      // carry it as a string id, not an object. Either way this throws.
      const invoice = event.data.object as unknown as { subscription: { id: string } };
      console.log(`invoice paid for subscription ${invoice.subscription.id}`);
      break;
    }
    default:
      console.log(`ignored ${event.type}`);
  }
}

server.listen(port, () => console.log(`webhook fixture listening on http://localhost:${port}/webhook`));
