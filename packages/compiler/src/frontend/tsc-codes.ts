/** Compiler options adopted from the project during preflight. */
export const ADOPTED_OPTIONS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
  "allowUnusedLabels",
  "allowUnreachableCode",
  "skipLibCheck",
  // Import-form interop knobs: they only change which import FORMS
  // typecheck (default imports of CJS-shaped types) — the import fence
  // rejects unsupported forms with SC-diagnostics either way, and a
  // SC1012 "not supported yet" beats a raw TS1259 at the same site.
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  // JSX: the checker types JSX as the project's tsc does, and the JSX
  // lowering (jsx-source.ts) emits the calls that setting selects.
  "jsx",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "reactNamespace",
] as const;

/* ── The early-error boundary (read this before relaxing a code) ────────
 *
 * Some of the codes below do double duty: TypeScript reports them for a
 * JavaScript construct that ECMAScript ALSO makes a SyntaxError (a
 * redeclared block binding, a declaration in a statement-only position).
 * Relaxing such a code removes that construct's only rejection, so a
 * parse-negative program would start compiling and running.
 *
 * frontend/early-errors.ts owns those rejections now, under their own
 * preflight codes — SC0005 (duplicate lexical declaration in a block or
 * switch statement list), SC0006 (lexical declaration colliding with a
 * `var` in the same block), SC0007 (declaration in a single-statement
 * position). A relaxation that needs one of those rules to keep firing must
 * land with the matching rule in that pass, not rely on this table. */

export const JS_RELAXED_TSC_CODES: ReadonlySet<number> = new Set([
  // implicit any (params, variables, elements, this, returns, rest,
  // construct signatures, index reads over shapes with no index
  // signature — typeof globalThis)
  2683,
  7005,
  7006,
  7008,
  7009,
  7010,
  7015,
  7017,
  7019,
  7022,
  7023,
  7024,
  7031,
  7034,
  7053,
  // strict-null narrowing demands (possibly null/undefined receivers)
  2531,
  2532,
  2533,
  18047,
  18048,
  18049,
  // assignability/arity/callability of dynamic call shapes (valid JS,
  // checked at runtime by Node; the lowerer re-checks every lowered form
  // per site) and member/existence probes over dynamic shapes (expando
  // properties, capability probes — the lowerer fences unknown members
  // per site with the SC2020 family)
  2322,
  2339,
  2345,
  2349,
  2351,
  2367,
  2554,
  2555,
  2556,
  2769,
  2740, // 2322's elaborated "missing the following properties" form
  2559, // a value with no properties in common with an all-optional options type
  2305,
  2551,
  2724,
  2731,
  // excess object-literal properties against a JSDoc-inferred contextual
  // type (and the did-you-mean variant): ordinary, working JS — the extra
  // key rides the object at runtime exactly as written (the formatter idiom's
  // expand-patterns passes an ignoreUnknown member its own JSDoc type
  // never declared)
  2353,
  2561,
  // JSDoc TYPE-SPACE claims that fail to check: a value name in a type
  // position (2749/2702), generic constraints and index types spelled in
  // typedefs (2344/2536/2538), an async @returns that is not Promise
  // (1064), and 2366's no-ending-return against a JSDoc-declared return
  // type. The claims are documentation — Node never reads them; the
  // values keep their runtime behavior and every use meets the per-site
  // fences (the pattern's source carries dozens of each).
  2749,
  2702,
  2344,
  2536,
  2538,
  1064,
  2366,
  // strict-null demands on dynamic shapes, continued: iterating/invoking
  // possibly-undefined values (runtime re-checks at the site)
  2488,
  2721,
  2722,
  // the async-iterator protocol demand (2504: "must have a
  // '[Symbol.asyncIterator]()' method that returns an async iterator").
  // Whether a value is async-iterable is a runtime fact of untyped JS, exactly
  // like the sync demand (2488) relaxed above: `for await` over a non-iterable
  // value and `yield*` in an async generator both lower through the runtime
  // protocol openers, which read the method, call it, and throw TypeError at
  // the site when it is missing, uncallable, or returns a non-object — the
  // same protocol failure Node reports. 2505 is the sync sibling on the typed
  // lowering lanes and stays enforced.
  2504,
  // an UNUSED @ts-expect-error: the directive annotated an error visible
  // under the project's OWN tsconfig world — scriptc's world deliberately
  // differs (adopted options, hidden declaration twins), and an unused
  // suppression changes nothing at runtime
  2578,
  // a primitive on the left of instanceof (`"x" instanceof String`): Node
  // answers false, which the lowering folds
  2358,
  // a lib-floor demand (es2024+ members under the es2023 lib): the member
  // types as the error-any and its use fences per site with the honest
  // no-lowering story instead of gating the whole program
  2550,
  // `export *` ambiguity (2308): Node DEFINES this case — ambiguous names
  // are excluded from the star surface — where tsc asks for an explicit
  // re-export; and 2305's did-you-mean sibling 2614 joins 2305
  2308,
  2614,
  // 2740's sibling elaboration ("Property X is missing in type Y")
  2741,
  // JavaScript subclasses may widen fields or add method parameters.
  // Class lowering checks native storage and override ABIs at each use.
  2415,
  // a private or protected constructor (`new readline.Interface(...)`,
  // whose declaration is protected): JavaScript has no constructor
  // accessibility, and Node constructs the class. Each `new` meets the
  // lowerer's per-site constructor fences.
  2673,
  2674,
  // unresolvable modules: Node throws WHEN the require executes — the
  // binding types as any and reached uses fence instead of passing unchecked
  2307,
  2792,
  // a write to a property declarations mark readonly (2540): `readonly` is
  // a type annotation that Node never sees (Next.js's types mark
  // process.env.NODE_ENV readonly; its server.js assigns it); the write
  // lowers like any other and keeps its runtime behavior
  2540,
  // a resolved JavaScript module without declarations (7016): Node loads
  // it like any other module; deployment trees such as Next.js standalone
  // output ship runtime files only, so the binding types as any and its
  // uses take the dynamic paths, as for 2307
  7016,
  // `delete` of a property the inference typed required (2790): JS deletes
  // any configurable property, and the lowering checks each delete's
  // receiver itself
  2790,
  // useUnknownInCatchVariables' annotation demand ("'e' is of type
  // 'unknown'", "Object is of type 'unknown'"): a JS catch clause CANNOT
  // annotate its variable, so the demand is unsatisfiable in source —
  // exactly the implicit-any story above. The values stay 'unknown' and
  // every use meets the lowerer's per-site unknown fences (member reads
  // ride the checked-dynamic tree; unsupported operations report a compile-time diagnostic).
  18046,
  2571,
  // UNDECLARED NAMES in a JavaScript source: Node resolves them at run time,
  // never at compile time — a READ throws the catchable
  // `ReferenceError: <name> is not defined` at the access (`typeof` of one
  // answers "undefined"), and a sloppy-mode WRITE creates a global. The
  // lowerer turns the read into `scr_undef_global_read` (exact Node text and
  // behavior) and refuses the write with SC1091, which names the Node-island
  // route the sloppy semantics need (the plan's D-2/D-5). TypeScript input
  // keeps the compile error: an undeclared name there is a bug, not a
  // runtime path. 2552 is 2304's did-you-mean spelling, and 18004 is the
  // same unresolved name in SHORTHAND position (`{ x }`), which the checker
  // reports against the property instead of the reference.
  2304,
  2552,
  18004,
]);

/* Arithmetic on an `any` operand (TS2362/2363/2365 fire when the other
 * side is bigint-ish): plain JS — relaxed only when 'any' participates. */
export const JS_ANY_OPERATOR_CODES: ReadonlySet<number> = new Set([2362, 2363, 2365]);

/** True for JavaScript source file NAMES (.js/.mjs/.cjs/.jsx) — the files
 * whose types come entirely from inference (checkJs + JSDoc) and whose JS
 * relaxation stance applies. */
export function isJsSourceFileName(fileName: string): boolean {
  // The same classification as /\.(js|mjs|cjs|jsx)$/, without a regular
  // expression: this runs for most type queries.
  return (
    fileName.endsWith(".js") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".cjs") ||
    fileName.endsWith(".jsx")
  );
}
