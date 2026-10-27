// A published bundle's generic factory whose JSDoc names its result by a
// type that only the package's .d.ts declares (hono's `bearerAuth`:
// `@template E` + `@returns {MiddlewareHandler<E>}`), passed straight into
// a generic registration method. The unresolved JSDoc result is not a
// contract, so the call's result is checked-dynamic.
import { guard, Router } from "jsdocmw";

const router = new Router();
router.on("/admin", guard({ token: "s3cret" }), async (ctx, next) => {
  ctx.log.push(`handler ${ctx.path}`);
  await next();
});
const open = guard({ token: "" });
router.on("/open", open, async (ctx) => {
  ctx.log.push(`open handler ${ctx.path}`);
});
console.log(await router.dispatch("/admin", "s3cret"));
console.log(await router.dispatch("/admin", "nope"));
console.log(await router.dispatch("/open", ""));
