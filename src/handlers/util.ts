import { type Ctx, fail, type RCtx } from "../lib/context.js";
import { StripeApiError } from "../lib/stripe.js";
import { isRecord } from "../lib/validate.js";

export function body(ctx: RCtx): Record<string, unknown> {
	return isRecord(ctx.input) ? ctx.input : {};
}

/** Run a Stripe call, mapping Stripe failures to route errors without echoing Stripe's message. */
export async function stripeCall<T>(ctx: Ctx, label: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof StripeApiError) {
			ctx.log.warn(`Stripe ${label} failed`, {
				status: error.status,
				type: error.type,
				code: error.stripeCode,
			});
			if (error.isAuthError) {
				fail("STRIPE_KEY_REJECTED", "Stripe rejected this site's API key. An administrator needs to reconnect Stripe.", 502);
			}
			fail("STRIPE_ERROR", `Stripe could not complete the request (${label}).`, 502);
		}
		throw error;
	}
}
