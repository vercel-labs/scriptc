/** Calls the function `name` exported by the module `specifier` and returns
 * its result.
 *
 * In scriptc builds the call runs in Node.js loaded into the program on
 * the first call (the libnode pack recorded at build time, or
 * SCRIPTC_LIBNODE). Under Node.js it runs in the same process too. Either
 * way:
 *
 * - the module loads with require() from the calling module, so a relative
 *   specifier resolves from the caller's directory and a bare one from its
 *   node_modules (ES modules load through require(esm));
 * - the arguments cross as a copy, `JSON.parse(JSON.stringify(args))`, and
 *   the function runs with the module namespace as `this`;
 * - the result crosses as its JSON copy (undefined stays undefined), and
 *   scriptc checks it against `T` like `JSON.parse(text) as T`;
 * - a thrown Error crosses as a new error of its nearest intrinsic class
 *   (Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError,
 *   URIError) with its message and string `code`; other thrown values cross
 *   as JSON copies.
 *
 * A function that returns a promise cannot be called synchronously: the
 * call throws a TypeError. Use {@link call}. */
export declare function callSync<T = unknown>(
  specifier: string,
  name: string,
  ...args: unknown[]
): T;

/** Like {@link callSync}, asynchronously: the function may return a
 * promise, whose result is copied when it settles. The returned promise
 * rejects instead of throwing, also when the arguments cannot be copied. */
export declare function call<T = unknown>(
  specifier: string,
  name: string,
  ...args: unknown[]
): Promise<T>;

/** Loads the module `specifier` with require() from the calling module and
 * returns its exports **by reference** (scope-B Node islands, NI-4).
 *
 * In scriptc builds the module runs in Node.js loaded into the program on
 * first use; the specifier must be a string literal, resolved at build time
 * as `require.resolve` resolves it from the caller. The exports and every
 * object reached through them stay Node objects: the program holds handles
 * to them, so identity, aliasing and mutation are shared with Node.
 * Primitives, strings and BigInt are copied; promises become promises;
 * Buffers and typed arrays share their memory. Under Node.js this is
 * `createRequire(callerFile)(specifier)`. */
export declare function requireModule<T = any>(specifier: string): T;
