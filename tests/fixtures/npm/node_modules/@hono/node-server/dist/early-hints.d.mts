import { Context, Env, MiddlewareHandler } from "hono";

//#region src/early-hints.d.ts
type EarlyHintsOptions<E extends Env = Env> = {
  link: string | string[] | ((c: Context<E>) => string | string[] | undefined);
};
/**
 * Early Hints middleware for Node.js
 * Automatically sends a 103 Early Hints informational response with the specified Link header(s).
 *
 * @param options EarlyHintsOptions
 * @returns MiddlewareHandler
 */
declare const earlyHints: <E extends Env = any>(options: EarlyHintsOptions<E>) => MiddlewareHandler<E>;
//#endregion
export { EarlyHintsOptions, earlyHints };