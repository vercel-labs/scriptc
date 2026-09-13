/* scriptc's divergence and precision overrides — interface merges that
 * re-type a handful of standard-library members to scriptc's documented
 * runtime behavior. Merged interfaces resolve overloads later-declaration-
 * first, so these win at call sites that match them; call forms only the
 * lib signatures accept still typecheck and are fenced by the lowerer.
 *
 * This file is part of the LOWERING program only. Preflight's second-chance
 * pass (checkPreflight) rebuilds the program WITHOUT it — the project's own
 * type world — so a program that typechecks under its own tsc is never
 * rejected over an override-manufactured error; the affected sites meet the
 * lowerer's honest fences instead (SC1100's checked-cast family for
 * JSON.parse results, the executor fences for Promise shapes). The
 * primitives every world needs (comptime, setTimeout, __island_eval) live
 * in scriptc.d.ts, which ships to BOTH programs. */

/* `at(): string`, not the lib's `string | undefined`: undefined is
 * unrepresentable, so an out-of-range at() THROWS a catchable TypeError at
 * the validated island exit instead of returning undefined (documented
 * divergence, SEMANTICS.md). */
interface String {
  at(index: number): string;
}

/* Object.values/entries with the actual field-value union, not the lib's
 * `any` (the lib's precise overloads only cover index-signature and
 * ArrayLike sources). A PRECISION override, not a divergence: the lowering
 * emits the field list statically and the values are exactly T[keyof T] —
 * without this the result would be `any`-typed and drag every downstream
 * use into the island. */
interface ObjectConstructor {
  values<T extends object>(o: T): Array<T[keyof T]>;
  entries<T extends object>(o: T): Array<[string, T[keyof T]]>;
}

/* `parse` returns `unknown`, not the lib's `any` — the dynamic boundary. A
 * checked cast (`JSON.parse(s) as Config`) validates the value against the
 * target type at runtime and THROWS on mismatch — the mechanism that makes
 * trusting TS types sound at data boundaries. The lib's any-returning
 * overload stays reachable only through the reviver form, which the
 * lowerer rejects (as it does stringify's replacer/space parameters).
 *
 * `stringify` takes `unknown`, not the lib's `any`: the same honest
 * surface, but the parameter must not CONTEXTUALLY TYPE literal arguments
 * as `any` (an any-typed slot is the island boundary; `JSON.stringify([1,
 * 2])` must keep building a static array and serializing it
 * type-directedly). */
interface JSON {
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

/* The supported Promise construction shape: an executor whose resolve takes
 * the plain value. Preferred over the lib signature at inference time, so
 * `new Promise<T>((resolve) => ...)` types resolve as `(value: T) => void`
 * — no PromiseLike union. The reject parameter is a real closure rejecting
 * the promise; its reason is pinned to Error (the lib says `reason?: any`)
 * because rejection payloads ride the same representation as thrown values
 * and the idiomatic reason IS an Error — reject(nonError) and bare
 * reject() typecheck only in the project world and meet the lowerer's
 * honest coercion fences instead. First settle wins, exactly JS: a reject
 * after resolve (or a second reject) is a no-op, and an executor throw
 * after any settle is swallowed. Executors that use the lib signature's
 * other extras (resolving with a thenable) still typecheck and fail
 * lowering on their types. */
interface PromiseConstructor {
  new <T>(
    executor: (resolve: (value: T) => void, reject: (reason: Error) => void) => void,
  ): Promise<T>;
  /* ES2024's Promise.withResolvers, in the executor's own scriptc shape:
   * resolve takes the plain value (no PromiseLike union; the conditional
   * collapses Promise<void>'s resolve to () => void so the record's
   * field types map exactly), reject is the executor's Error-pinned
   * rejection closure. The lib's own declaration would otherwise be
   * unrepresentable field-by-field. */
  withResolvers<T>(): {
    promise: Promise<T>;
    // `0 extends 1 & T` detects any (untyped JS: Promise.withResolvers()
    // infers it) — its settled value rides the dyn arm like unknown's,
    // so resolve takes one unknown; a naked conditional over any would
    // otherwise union BOTH branches, which no field can map.
    resolve: 0 extends 1 & T
      ? (value: unknown) => void
      : [T] extends [void]
        ? () => void
        : (value: T) => void;
    reject: (reason: Error) => void;
  };
}
