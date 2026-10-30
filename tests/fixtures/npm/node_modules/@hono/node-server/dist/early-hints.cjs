Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

//#region src/early-hints.ts
/**
* Early Hints middleware for Node.js
* Automatically sends a 103 Early Hints informational response with the specified Link header(s).
*
* @param options EarlyHintsOptions
* @returns MiddlewareHandler
*/
const earlyHints = (options) => {
	let warned = false;
	return async (c, next) => {
		const mode = c.req.header("Sec-Fetch-Mode");
		const dest = c.req.header("Sec-Fetch-Dest");
		if (mode && mode !== "navigate" || dest && dest !== "document") return next();
		const env = c.env || {};
		const outgoing = ("server" in env ? env.server : env)?.outgoing;
		if (typeof outgoing?.writeEarlyHints !== "function") {
			if (!warned) {
				console.warn("Early Hints Middleware is not supported because writeEarlyHints is not defined.");
				warned = true;
			}
			return await next();
		}
		if (!outgoing.headersSent) {
			const link = typeof options.link === "function" ? options.link(c) : options.link;
			if (link !== void 0 && (Array.isArray(link) ? link.length > 0 : Boolean(link))) outgoing.writeEarlyHints({ link });
		}
		await next();
	};
};

//#endregion
exports.earlyHints = earlyHints;