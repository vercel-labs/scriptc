/* scriptc's shipped declarations — the ALWAYS-SHIPPED CORE. Programs
 * compile against the REAL TypeScript standard library (lib.es2023, no
 * dyn, no @types): the checker sees the full standard surface, and the
 * LOWERER is the scope fence — any reached use of standard-library surface
 * without a lowering is a SC2020 diagnostic at its use site. This file
 * declares only what the es2023 lib does not:
 *
 * 1. scriptc's own primitives (comptime, __island_eval).
 * 2. setTimeout/clearTimeout and the Timeout handle (Node/dyn territory the
 *    lib files don't cover; plain declarations, so with @types/node present
 *    they MERGE as overloads instead of colliding — the Timeout handle maps
 *    to the numeric timer id either way, and .unref()/.ref()/.hasRef() are
 *    loop-liveness bookkeeping).
 *
 * This file ships to EVERY program scriptc builds — the lowering program
 * and preflight's project-world second-chance program alike (a project
 * using comptime must typecheck in both). The divergence/precision
 * overrides (JSON.parse(): unknown, the Promise executor shape,
 * ...) live in scriptc-overrides.d.ts, which joins the LOWERING program only.
 *
 * console, process, and the "node:fs" module live in scriptc-node-fallback.d.ts,
 * shipped ONLY when the target project has no @types/node — with it, the
 * project's real Node types are the type surface and the fallback stands
 * down (its `declare const`/`declare module` forms would collide). The
 * lowering tables recognize the same members either way, by name +
 * provenance. */

/* The timer handle — setTimeout's return, mapped to the numeric timer id.
 * unref() drops it from the event loop's keep-alive set (the process may
 * exit with the timer still armed — it never fires then, exactly Node);
 * ref() restores it; hasRef() reports the state. The methods return the
 * handle for chaining. Under @types/node this MERGES with NodeJS.Timeout
 * (both map to the same numeric handle). */
interface Timeout {
  ref(): Timeout;
  unref(): Timeout;
  hasRef(): boolean;
  /* Re-arms the timer to fire at now + the original delay (Node's
   * Timeout.refresh). Chaining like ref/unref. */
  refresh(): Timeout;
}
/* The callback is invoked with NO arguments; the second overload admits a
 * callback declared with one parameter for the sleep idiom —
 * `setTimeout(resolve, ms)` with Promise<unknown>'s resolve — where the
 * zero-argument invocation delivers undefined (@types/node's generic
 * signature admits the same shape and MERGES with these). Promise<void>'s
 * resolve keeps matching the first overload (void params accept absence). */
declare function setTimeout(callback: () => void, ms?: number): Timeout;
declare function setTimeout(callback: (value?: unknown) => void, ms?: number): Timeout;
/* The trailing-argument form: Node passes the extras to the callback
 * (`setTimeout(cb, 0, 'foo')` fires cb('foo')). The callback slot accepts
 * any function shape (never[] rest — parameter-contravariance's bottom);
 * the delivered call rides the checked-dynamic boundary, so each argument
 * is validated against the callback's real signature at fire time. */
declare function setTimeout(callback: (...args: never[]) => void, ms?: number, ...args: unknown[]): Timeout;
declare function clearTimeout(handle?: Timeout | number | null | undefined): void;

/* Compile-time evaluation. The callback must be an inline arrow/function
 * expression with NO references to outer bindings (it is extracted
 * source-textually and executed in an isolated node:vm context inside the
 * COMPILER's Node process); the returned value is baked into the binary as a
 * literal — numbers (finite), strings, booleans, arrays, and records,
 * nested. What type-checks runs with real JavaScript semantics, so the
 * baked result is exactly what Node would compute at runtime (the
 * differential harness verifies this with a `comptime = (f) => f()` shim). */
declare function comptime<T>(compute: () => T): T;

/* INTERNAL TESTING HOOK — not part of the supported surface, deliberately
 * undocumented. Evaluates `code` in the embedded dynamic-island engine and
 * returns String(result); island exceptions arrive as catchable errors.
 * Requires --dynamic (a clean diagnostic otherwise). This exists to prove
 * the engine embed end-to-end in tests; user-facing constructs will lower
 * to the island through their own paths, not through this. */
declare function __island_eval(code: string): string;
