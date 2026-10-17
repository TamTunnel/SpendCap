// Unit tests for hosted billing.
//
// Webhook signature verification is tested for real with Stripe's own
// test helpers (`generateTestHeaderString` + `constructEvent`): a tampered
// payload or wrong secret must fail the HMAC check, no mocks involved.
// The D1 side uses a minimal in-memory D1Database stand-in that supports
// exactly the queries handleWebhook/getSubscription issue — production
// uses a real D1 database with 0002_billing.sql applied.
//
// MANUAL TEST (createCheckoutSession against live Stripe test mode — not
// runnable in CI, run once when wiring the hosted control plane):
//   1. In the Stripe dashboard (test mode): Products → create "Spendcap Pro",
//      $49/month recurring → copy its price ID (price_...).
//   2. export STRIPE_PRICE_ID=price_... STRIPE_SECRET_KEY=sk_test_...
//   3. Call createCheckoutSession and confirm the returned session has
//      mode 'subscription', one $49 line item, and metadata.org_id set.
//   4. Open session.url in a browser, pay with 4242 4242 4242 4242,
//      then trigger the endpoint event with `stripe listen` /
//      `stripe trigger checkout.session.completed` and confirm the
//      subscriptions row flips to status='active'.

import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { createCheckoutSession, getSubscription, handleWebhook } from '../src/stripe.js';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';

// Minimal in-memory D1Database stand-in: implements prepare/bind/run/first
// for the exact SQL this package issues, so the webhook→upsert→read path
// is genuinely exercised (upsert semantics included).
function makeFakeDb() {
  interface Row {
    org_id: string;
    stripe_customer_id: string | null;
    status: string;
    current_period_end: string | null;
  }
  const rows = new Map<string, Row>();

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (/INSERT INTO subscriptions/i.test(sql)) {
                const [org_id, stripe_customer_id, current_period_end] = params as [
                  string,
                  string | null,
                  string | null,
                ];
                rows.set(org_id, {
                  org_id,
                  stripe_customer_id,
                  status: 'active',
                  current_period_end,
                });
              }
              if (/UPDATE subscriptions/i.test(sql)) {
                const [status, org_id] = params as [string, string];
                const row = rows.get(org_id);
                if (row) row.status = status;
              }
              return { success: true };
            },
            async first() {
              if (/FROM subscriptions/i.test(sql)) {
                return rows.get(params[0] as string) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, rows };
}

function checkoutCompletedPayload(orgId: string): string {
  return JSON.stringify({
    id: 'evt_test_123',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        object: 'checkout.session',
        customer: 'cus_test_123',
        metadata: { org_id: orgId },
      },
    },
  });
}

function sign(payload: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

describe('handleWebhook', () => {
  it('verifies the signature and upserts an active subscription', async () => {
    const { db, rows } = makeFakeDb();
    const payload = checkoutCompletedPayload('org_abc');
    const result = await handleWebhook(payload, sign(payload), WEBHOOK_SECRET, db);

    expect(result).toEqual({ handled: true, orgId: 'org_abc' });
    expect(rows.get('org_abc')).toMatchObject({
      org_id: 'org_abc',
      stripe_customer_id: 'cus_test_123',
      status: 'active',
    });
    // Round-trip through the read path.
    expect(await getSubscription(db, 'org_abc')).toMatchObject({
      org_id: 'org_abc',
      status: 'active',
    });
  });

  it('is idempotent: redelivery of the same event leaves one row', async () => {
    const { db, rows } = makeFakeDb();
    const payload = checkoutCompletedPayload('org_abc');
    const sig = sign(payload);
    await handleWebhook(payload, sig, WEBHOOK_SECRET, db);
    await handleWebhook(payload, sig, WEBHOOK_SECRET, db);
    expect(rows.size).toBe(1);
    expect(rows.get('org_abc')?.status).toBe('active');
  });

  it('rejects a tampered payload', async () => {
    const { db } = makeFakeDb();
    const payload = checkoutCompletedPayload('org_abc');
    const sig = sign(payload);
    await expect(handleWebhook(payload + '"tampered":true}', sig, WEBHOOK_SECRET, db)).rejects.toThrow(
      /signature/i,
    );
  });

  it('rejects the wrong webhook secret', async () => {
    const { db, rows } = makeFakeDb();
    const payload = checkoutCompletedPayload('org_abc');
    await expect(handleWebhook(payload, sign(payload), 'whsec_wrong', db)).rejects.toThrow(
      /signature/i,
    );
    expect(rows.size).toBe(0);
  });

  it('ignores unrelated event types without touching the db', async () => {
    const { db, rows } = makeFakeDb();
    const payload = JSON.stringify({
      id: 'evt_test_456',
      object: 'event',
      type: 'customer.created',
      data: { object: { id: 'cus_x', object: 'customer' } },
    });
    const result = await handleWebhook(payload, sign(payload), WEBHOOK_SECRET, db);
    expect(result).toEqual({ handled: false });
    expect(rows.size).toBe(0);
  });

  it('fix-17-subscription-deleted: customer.subscription.deleted flips the row to canceled', async () => {
    const { db, rows } = makeFakeDb();
    // The org subscribes first...
    await handleWebhook(checkoutCompletedPayload('org_abc'), sign(checkoutCompletedPayload('org_abc')), WEBHOOK_SECRET, db);
    expect(rows.get('org_abc')?.status).toBe('active');
    // ...then cancels: Stripe sends customer.subscription.deleted.
    const payload = JSON.stringify({
      id: 'evt_test_789',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_123',
          object: 'subscription',
          customer: 'cus_test_123',
          metadata: { org_id: 'org_abc' },
        },
      },
    });
    const result = await handleWebhook(payload, sign(payload), WEBHOOK_SECRET, db);
    expect(result).toEqual({ handled: true, orgId: 'org_abc' });
    expect(rows.get('org_abc')?.status).toBe('canceled');
    expect(await getSubscription(db, 'org_abc')).toMatchObject({ status: 'canceled' });
  });

  it('fix-17-subscription-deleted requires metadata.org_id', async () => {
    const { db } = makeFakeDb();
    const payload = JSON.stringify({
      id: 'evt_test_790',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', object: 'subscription', metadata: {} } },
    });
    await expect(handleWebhook(payload, sign(payload), WEBHOOK_SECRET, db)).rejects.toThrow(
      /metadata\.org_id/,
    );
  });
});

describe('createCheckoutSession', () => {
  it('fails fast with a clear error when STRIPE_PRICE_ID is missing', async () => {
    const saved = process.env.STRIPE_PRICE_ID;
    delete process.env.STRIPE_PRICE_ID;
    try {
      await expect(
        createCheckoutSession('sk_test_dummy', {
          orgId: 'org_abc',
          successUrl: 'https://app.example/success',
          cancelUrl: 'https://app.example/cancel',
        }),
      ).rejects.toThrow(/STRIPE_PRICE_ID/);
    } finally {
      if (saved !== undefined) process.env.STRIPE_PRICE_ID = saved;
    }
  });
});
