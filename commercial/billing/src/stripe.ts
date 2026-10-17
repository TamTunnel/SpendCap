// Stripe billing for the Spendcap *hosted* tier (commercial/).
//
// Self-hosters: you don't need any of this. Billing exists only in the
// hosted control plane; the OSS core has no Stripe dependency and no
// notion of plans.
//
// Pricing model: a single flat $49/month "Spendcap Pro" plan. The price
// itself lives in Stripe (created once in the Stripe dashboard; its ID is
// passed via STRIPE_PRICE_ID). This package never hard-codes amounts.
//
// Deliberately OUT OF SCOPE: usage-based / metered billing. Metered
// billing (Stripe Meter Events, idempotency keys, backfill/reconciliation)
// adds real operational complexity with no payoff while metered volume
// sits comfortably inside a flat plan's margin. If it ever returns, it
// belongs here as a separate meter-events pipeline — not bolted onto this.

import Stripe from 'stripe';

export interface CheckoutSessionOptions {
  orgId: string;
  successUrl: string;
  cancelUrl: string;
}

/** The flat $49/mo "Spendcap Pro" price ID, set from the Stripe dashboard. */
function requirePriceId(): string {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    throw new Error(
      'STRIPE_PRICE_ID is not set. Create the $49/mo "Spendcap Pro" recurring ' +
        'price in the Stripe dashboard and export its price ID (price_...) as STRIPE_PRICE_ID.',
    );
  }
  return priceId;
}

/**
 * Create a Stripe Checkout Session for the flat $49/mo "Spendcap Pro"
 * subscription. Checkout itself is hosted by Stripe; this only starts the
 * session and returns it so the caller can redirect the buyer to
 * `session.url`. The org is stitched back to us via
 * `metadata.org_id`, which the webhook handler reads.
 */
export async function createCheckoutSession(
  stripeSecretKey: string,
  opts: CheckoutSessionOptions,
): Promise<Stripe.Checkout.Session> {
  const stripe = new Stripe(stripeSecretKey);
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: requirePriceId(), quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: { org_id: opts.orgId },
  });
}

export interface WebhookResult {
  handled: boolean;
  orgId?: string;
}

export interface Subscription {
  org_id: string;
  stripe_customer_id: string | null;
  status: string;
  current_period_end: string | null;
}

/**
 * Verify a Stripe webhook payload (HMAC signature) and act on it.
 *
 * IMPORTANT: pass the *raw* request body (string/Buffer exactly as
 * received), never the JSON-parsed object — Stripe signs the raw bytes.
 *
 * On `checkout.session.completed`: upserts the org's row in the
 * `subscriptions` table (packages/data/migrations/0003_billing.sql) with
 * status='active'. The upsert is idempotent — Stripe retries deliveries,
 * and re-delivering the same event leaves the same row.
 *
 * Events of any other type return `{ handled: false }` and touch nothing.
 *
 * Cancellation coverage (documented): only `customer.subscription.deleted`
 * flips the row to status='canceled'. Other cancellation-shaped events
 * (e.g. `customer.subscription.updated` with cancel_at_period_end, or a
 * deleted customer) are deliberately NOT handled here — the row keeps its
 * last known status until the terminal deleted event arrives. If the hosted
 * control plane ever needs grace-period semantics, that belongs in a
 * dedicated subscription-state machine, not in this handler.
 */
export async function handleWebhook(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
  db: D1Database,
): Promise<WebhookResult> {
  const event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const orgId = sub.metadata?.org_id;
    if (!orgId) {
      throw new Error('customer.subscription.deleted missing metadata.org_id');
    }
    await db
      .prepare('UPDATE subscriptions SET status = ? WHERE org_id = ?')
      .bind('canceled', orgId)
      .run();
    return { handled: true, orgId };
  }

  if (event.type !== 'checkout.session.completed') {
    return { handled: false };
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const orgId = session.metadata?.org_id;
  if (!orgId) {
    throw new Error('checkout.session.completed missing metadata.org_id');
  }
  const customerId = typeof session.customer === 'string' ? session.customer : null;

  await db
    .prepare(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, status, current_period_end)
       VALUES (?, ?, 'active', ?)
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         status = 'active',
         current_period_end = excluded.current_period_end`,
    )
    .bind(orgId, customerId, null)
    .run();

  return { handled: true, orgId };
}

/** Read an org's subscription row; null when the org has never paid. */
export async function getSubscription(db: D1Database, orgId: string): Promise<Subscription | null> {
  const row = await db
    .prepare(
      'SELECT org_id, stripe_customer_id, status, current_period_end FROM subscriptions WHERE org_id = ?',
    )
    .bind(orgId)
    .first<Subscription>();
  return row ?? null;
}
