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
  // ---- The checker's OPINIONS about legal JavaScript ----
  // Each diagnostic below reports that a construct is unusual for TypeScript,
  // never that it is illegal JavaScript: Node gives it a defined runtime
  // meaning and the lowerer already builds it. TypeScript input keeps every
  // one of them.
  //
  // 2695, an unused comma-operand left side (`(0, fn)`, `(0, [[x]] = [])`):
  // the operator evaluates the left operand for its effects and yields the
  // right one; the lowerer emits a sequence expression for it. The 2026-10-29
  // campaign baseline records 555 refusal variants whose diagnostics include
  // this message, 508 of them with no other diagnostic, across 281 files;
  // corpus 8700 pins the lowered list against Node.
  2695,
  // 18050, `null`/`undefined` in an arithmetic or bitwise position
  // (`null + undefined`, `null * 3`): ToNumber gives them 0 and NaN, which
  // the numeric coercion implements for a unit literal; the demand comes
  // from strictNullChecks, not from JavaScript. Baseline: 416 refusal variants
  // (390 sole, 208 files); corpus 8702 pins the numeric result against Node.
  18050,
  // 7057, a `yield` in a generator with no return-type annotation: the
  // generator protocol is untyped in JavaScript and the sent value is
  // whatever the caller passes. The generator lowering owns the channels.
  // Baseline: 312 refusal variants (275 sole, 165 files); corpus 8703 pins
  // the sent values and the completion against Node.
  7057,
  // 7032, a set accessor whose parameter has no type annotation ("property
  // implicitly has type 'any'"): a JavaScript setter's parameter is whatever
  // the caller passes. The lowering gives the parameter checked-dynamic
  // storage (`paramShape`), and a read of it stays dynamic rather than
  // checking the caller's value back into the type the checker inferred from
  // a twin getter (jsWidenedBindings), so the stored value keeps its runtime
  // identity. A JSDoc `@param` type is an annotation like any other and keeps
  // its declared storage. Corpus 8701 stores a number, a string, an object,
  // null and undefined through object-literal and class setters and reads
  // each one back unchanged, plus a class setter that converts, a setter that
  // appends to an array, and a setter with no twin getter. A *private* setter
  // stays reported (`suppressedJsStrictness7`): the private-element lowering
  // does not yet implement the shadowing and brand-check semantics.
  7032,
]);

/* NOT relaxed, though each is legal JavaScript the checker merely dislikes:
 * the construct needs a lowering that does not exist yet, so admitting the
 * code would compile a program the lowerer cannot build correctly.
 *
 *  - TS2365 (an operator on operands the lowerer cannot convert, `true + 1`)
 *    needs ToPrimitive on a static operand; the arithmetic lowering answers
 *    SC1043. Its TS2362/2363 siblings (an arithmetic operand of the wrong
 *    type) never fire on a JS source — TypeScript only demands an operand
 *    type it knows, and an unannotated JavaScript value is `any` — so the pair
 *    has nothing to relax here. The invalid-assignment-target forms the
 *    checker does report stay refused too: `f() += g()` (TS2364) and `f()++`
 *    (TS2357) are legal JavaScript, but Node CALLS `f` and then throws a
 *    ReferenceError ("Invalid left-hand side in assignment", "Invalid
 *    left-hand side expression in postfix operation"), and the lowering has
 *    no invalid-target path that calls and then throws. TS2362/2363 keep
 *    their `any`-only admission below.
 *  - TS2508 ("No base constructor has the specified number of type
 *    arguments", `class X extends Iterator {}`) needs extending a class
 *    declared outside the program; heritage lowering answers SC1090. The
 *    baseline records 296 refusal variants (268 sole, 148 files), every one a
 *    stdlib heritage (`extends Iterator`, `Iterator.from`,
 *    `Iterator.prototype.<method>` non-constructible tests).
 *  - TS1166 (a non-literal class-field key) needs a field the lowering can
 *    declare from a runtime key; the class lowering answers SC1090.
 *  - TS2704 ("The operand of a 'delete' operator cannot be a read-only
 *    property") is the `Object.defineProperty(obj, "p", ...)` idiom. The
 *    delete lowering is exact for an object literal and for a dynamic
 *    receiver, but a delete of a BUILTIN's own property
 *    (`delete String.prototype.charAt.length`,
 *    `delete Promise[Symbol.toStringTag]`) compiles and leaves the property
 *    in place, because the runtime delete has no view of the builtin's
 *    synthesized properties. Admitting the code therefore compiles programs
 *    that differ from Node (on the relaxed experiment tree, Test262
 *    Object/prototype/toLocaleString/S15.2.4.3_A9,
 *    String/prototype/charAt/S15.5.4.4_A9 and indexOf/S15.5.4.7_A9 fail).
 *    The lowering needs a builtin-receiver fence first. The baseline records
 *    255 refusal variants (191 sole, 162 files) for this code.
 *  - TS2464 (a computed property name whose type is not a literal) is exact
 *    for an OBJECT literal (the lowering converts a dynamic key with
 *    ToPropertyKey; the relaxed experiment tree passed every object-literal
 *    computed-name test), but a CLASS element name
 *    takes the class lowering's stable-key path, which neither coerces the
 *    key nor keeps Node's evaluation order: admitting the code makes
 *    `class C { [key]() {} }` with a ToPrimitive key compile and disagree
 *    with Node (Test262 computed-property-names/to-name-side-effects/class.js
 *    and expressions/class/elements/evaluation-error/computed-name-toprimitive-*
 *    fail). Class element names need the same ToPropertyKey lowering, or a
 *    refusal, before the code can be admitted.
 */

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
