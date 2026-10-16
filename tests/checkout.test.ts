import { describe, expect, it } from "vitest";

import { CHECKOUT_MAX_AGE_MS, checkoutCompleteHandler, checkoutHandler, verifyCheckoutSession } from "../src/handlers/checkout.js";
import { getSessionEmail } from "../src/lib/sessions.js";
import type { StripeCheckoutSession } from "../src/lib/stripe.js";
import { createHarness, stripeFetch } from "./support/fake-ctx.js";

const KEY = "sk_test_abcdefghijklmnop";

function session(overrides: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession {
	return {
		id: "cs_test_abc123",
		object: "checkout.session",
		url: null,
		status: "complete",
		payment_status: "paid",
		created: Math.floor(Date.now() / 1000) - 60,
		metadata: { rwstripe: "1" },
		customer: { id: "cus_1", email: "Buyer@Example.test" },
		customer_details: { email: "other@example.test" },
		...overrides,
	};
}

async function harnessWithStripe(routes: Parameters<typeof stripeFetch>[0], input: unknown = {}) {
	const calls: Parameters<typeof stripeFetch>[1] = [];
	const harness = createHarness({ input, fetch: stripeFetch(routes, calls) });
	await harness.settings.put("stripeSecretKey", KEY);
	return { ...harness, calls };
}

describe("verifyCheckoutSession", () => {
	it("accepts a fresh, paid session started by the plugin and prefers the customer's email", () => {
		expect(verifyCheckoutSession(session())).toEqual({ ok: true, email: "buyer@example.test" });
	});
	it("accepts no_payment_required (free trials)", () => {
		expect(verifyCheckoutSession(session({ payment_status: "no_payment_required" })).ok).toBe(true);
	});
	it("requires rwstripe metadata", () => {
		expect(verifyCheckoutSession(session({ metadata: {} }))).toMatchObject({ ok: false, code: "CHECKOUT_NOT_RECOGNIZED" });
		expect(verifyCheckoutSession(session({ metadata: null }))).toMatchObject({ ok: false, code: "CHECKOUT_NOT_RECOGNIZED" });
	});
	it("requires a completed, paid session", () => {
		expect(verifyCheckoutSession(session({ status: "open" }))).toMatchObject({ code: "CHECKOUT_INCOMPLETE" });
		expect(verifyCheckoutSession(session({ status: "expired" }))).toMatchObject({ code: "CHECKOUT_INCOMPLETE" });
		expect(verifyCheckoutSession(session({ payment_status: "unpaid" }))).toMatchObject({ code: "CHECKOUT_UNPAID" });
	});
	it("rejects sessions older than two hours", () => {
		const now = Date.now();
		const created = Math.floor((now - CHECKOUT_MAX_AGE_MS - 1000) / 1000);
		expect(verifyCheckoutSession(session({ created }), now)).toMatchObject({ code: "CHECKOUT_EXPIRED" });
	});
	it("falls back to customer_details when the customer is not expanded", () => {
		expect(verifyCheckoutSession(session({ customer: "cus_1" }))).toEqual({ ok: true, email: "other@example.test" });
	});
	it("requires an email", () => {
		expect(verifyCheckoutSession(session({ customer: null, customer_details: null }))).toMatchObject({ code: "CHECKOUT_NO_EMAIL" });
	});
});

describe("checkout/complete", () => {
	it("issues a session once per Checkout Session", async () => {
		const h = await harnessWithStripe({ "GET /checkout/sessions/cs_test_abc123": () => session() }, { session_id: "cs_test_abc123" });
		const first = await checkoutCompleteHandler(h.ctx);
		expect(first.email).toBe("buyer@example.test");
		expect(await getSessionEmail(h.ctx, first.session)).toBe("buyer@example.test");
		expect(h.calls[0]?.url.searchParams.get("expand[]")).toBe("customer");

		await expect(checkoutCompleteHandler(h.ctx)).rejects.toMatchObject({ code: "CHECKOUT_ALREADY_USED", status: 409 });
	});

	it("does not burn the session when verification fails", async () => {
		let status: StripeCheckoutSession["status"] = "open";
		const h = await harnessWithStripe(
			{ "GET /checkout/sessions/cs_test_abc123": () => session({ status }) },
			{ session_id: "cs_test_abc123" },
		);
		await expect(checkoutCompleteHandler(h.ctx)).rejects.toMatchObject({ code: "CHECKOUT_INCOMPLETE" });
		status = "complete";
		await expect(checkoutCompleteHandler(h.ctx)).resolves.toMatchObject({ email: "buyer@example.test" });
	});

	it("rejects malformed session ids before calling Stripe", async () => {
		const h = await harnessWithStripe({}, { session_id: "cs_test_abc/../../v1/customers" });
		await expect(checkoutCompleteHandler(h.ctx)).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("checkout", () => {
	const product = { id: "prod_A", active: true, name: "Gold", description: null, default_price: "price_1" };
	const routes = (type: "one_time" | "recurring") => ({
		"GET /prices/price_1": () => ({
			id: "price_1",
			active: true,
			currency: "usd",
			unit_amount: 500,
			type,
			recurring: type === "recurring" ? { interval: "month", interval_count: 1 } : null,
			product,
		}),
		"GET /customers": () => ({ data: [], has_more: false }),
		"POST /customers": () => ({ id: "cus_new", email: "buyer@example.test" }),
		"POST /checkout/sessions": () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
	});
	const input = { price_id: "price_1", email: " Buyer@Example.test ", return_path: "/posts/gold?x=1" };

	async function restricted(h: Awaited<ReturnType<typeof harnessWithStripe>>) {
		await h.stores.restrictions.put("posts:01ABC", { collectionSlug: "posts", contentId: "01ABC", productIds: ["prod_A"], updatedAt: "" });
	}

	it("creates invoices for one-time prices", async () => {
		const h = await harnessWithStripe(routes("one_time"), input);
		await restricted(h);
		expect(await checkoutHandler(h.ctx)).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
		const create = h.calls.find((call) => call.method === "POST" && call.path === "/checkout/sessions")!;
		expect(create.body.get("mode")).toBe("payment");
		expect(create.body.get("invoice_creation[enabled]")).toBe("true");
		expect(create.body.get("metadata[rwstripe]")).toBe("1");
		expect(create.body.get("customer")).toBe("cus_new");
		expect(create.body.get("success_url")).toBe("https://example.test/posts/gold?x=1&rwstripe_checkout={CHECKOUT_SESSION_ID}");
		expect(create.body.get("cancel_url")).toBe("https://example.test/posts/gold?x=1");
		const customer = h.calls.find((call) => call.method === "POST" && call.path === "/customers")!;
		expect(customer.body.get("email")).toBe("buyer@example.test");
	});

	it("uses subscription mode for recurring prices", async () => {
		const h = await harnessWithStripe(routes("recurring"), input);
		await restricted(h);
		await checkoutHandler(h.ctx);
		const create = h.calls.find((call) => call.method === "POST" && call.path === "/checkout/sessions")!;
		expect(create.body.get("mode")).toBe("subscription");
		expect(create.body.has("invoice_creation[enabled]")).toBe(false);
	});

	it("refuses prices whose product restricts nothing", async () => {
		const h = await harnessWithStripe(routes("one_time"), input);
		await expect(checkoutHandler(h.ctx)).rejects.toMatchObject({ code: "PRICE_UNAVAILABLE" });
		expect(h.calls.some((call) => call.path === "/checkout/sessions")).toBe(false);
	});

	it("refuses off-site return paths", async () => {
		const h = await harnessWithStripe(routes("one_time"), { ...input, return_path: "/\\evil.com" });
		await expect(checkoutHandler(h.ctx)).rejects.toMatchObject({ code: "INVALID_RETURN_PATH" });
	});

	it("fails closed without an absolute site URL", async () => {
		const h = createHarness({ input, siteUrl: "", fetch: stripeFetch(routes("one_time")) });
		await expect(checkoutHandler(h.ctx)).rejects.toMatchObject({ code: "SITE_URL_NOT_CONFIGURED" });
	});

	it("reports a clean error when Stripe is not configured", async () => {
		const h = createHarness({ input, fetch: stripeFetch({}) });
		await expect(checkoutHandler(h.ctx)).rejects.toMatchObject({ code: "STRIPE_NOT_CONFIGURED", status: 503 });
	});
});
