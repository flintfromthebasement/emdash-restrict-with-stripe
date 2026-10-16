// POST portal {session, return_path}: Stripe billing portal URL for the session's customer.

import { PORTAL_CONFIG_KEY, requireStripe } from "../lib/config.js";
import { fail, type RCtx, requireSiteOrigin } from "../lib/context.js";
import { getSessionEmail } from "../lib/sessions.js";
import { validateReturnPath } from "../lib/validate.js";
import { body, stripeCall } from "./util.js";

export async function portalHandler(ctx: RCtx): Promise<{ url: string }> {
	const input = body(ctx);
	const siteOrigin = requireSiteOrigin(ctx);
	const returnPath = validateReturnPath(input.return_path, siteOrigin);
	if (!returnPath) fail("INVALID_RETURN_PATH", "return_path must be a path on this site.");
	const email = await getSessionEmail(ctx, input.session);
	if (!email) fail("NOT_LOGGED_IN", "Log in to manage your purchases.", 401);

	const { config, stripe } = await requireStripe(ctx);
	const customers = await stripeCall(ctx, "customer lookup", () => stripe.listCustomersByEmail(email));
	const customer = customers.find((candidate) => !candidate.deleted);
	if (!customer) fail("NO_CUSTOMER", "No purchases were found for this email.", 404);

	// Cached per key so a different Stripe account never reuses another's configuration.
	const cached = await ctx.kv.get<{ keyHash: string; id: string }>(PORTAL_CONFIG_KEY);
	let configuration = cached?.keyHash === config.keyHash ? cached.id : null;
	if (!configuration) {
		configuration = await stripeCall(ctx, "portal configuration", () => stripe.ensurePortalConfiguration());
		await ctx.kv.set(PORTAL_CONFIG_KEY, { keyHash: config.keyHash, id: configuration });
	}
	const configurationId = configuration;
	const portal = await stripeCall(ctx, "portal session", () =>
		stripe.createPortalSession(customer.id, `${siteOrigin}${returnPath}`, configurationId),
	);
	return { url: portal.url };
}
