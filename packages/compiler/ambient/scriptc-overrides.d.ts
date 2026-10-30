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
 * primitives every world needs (comptime, setTimeout) live
 * in scriptc.d.ts, which ships to BOTH programs. */

interface String {
  at(index: number): string;
}

interface ObjectConstructor {
  values<T extends object>(o: T): Array<keyof T extends never ? unknown : T[keyof T]>;
  entries<T extends object>(o: T): Array<[string, keyof T extends never ? unknown : T[keyof T]]>;
}

interface JSON {
  parse(text: string): unknown;
  parse(text: string, reviver: (this: unknown, key: string, value: unknown) => unknown): unknown;
  stringify(value: unknown): string;
  stringify(
    value: unknown,
    replacer: (this: unknown, key: string, value: unknown) => unknown,
    space?: string | number,
  ): string | undefined;
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

/* Carriers of the types the lowerer gives untyped JavaScript collections
 * whose uses prove them (js-collection-types.ts). Nothing reads them at run
 * time. */
declare namespace __scriptcInferredCollections {
  const map_string_string: Map<string, string>;
  const map_string_number: Map<string, number>;
  const map_string_boolean: Map<string, boolean>;
  const map_number_string: Map<number, string>;
  const map_number_number: Map<number, number>;
  const map_number_boolean: Map<number, boolean>;
  const map_boolean_string: Map<boolean, string>;
  const map_boolean_number: Map<boolean, number>;
  const map_boolean_boolean: Map<boolean, boolean>;
  const set_string: Set<string>;
  const set_number: Set<number>;
  const set_boolean: Set<boolean>;
  const array_string: string[];
  const array_number: number[];
  const array_boolean: boolean[];
}
