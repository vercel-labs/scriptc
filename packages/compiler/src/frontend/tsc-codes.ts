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
 * position), SC0008 (an ImportCall argument list the grammar does not
 * allow), SC0009 (a private name with no declaring enclosing class) and
 * SC0010 (an assignment target that is not a variable or property access).
 * A relaxation that needs one of those rules to keep firing must
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
  // meaning and the lowerer already builds it. TypeScript input keeps all
  // three.
  //
  // 2695, an unused comma-operand left side (`(0, fn)`, `(0, [[x]] = [])`):
  // the operator evaluates the left operand for its effects and yields the
  // right one; the lowerer emits a sequence expression for it.
  2695,
  // 18050, `null`/`undefined` in an arithmetic or bitwise position
  // (`null + undefined`, `null * 3`): ToNumber gives them 0 and NaN, which
  // the numeric coercion implements for a unit literal; the demand comes
  // from strictNullChecks, not from JavaScript.
  18050,
  // 7057, a `yield` in a generator with no return-type annotation: the
  // generator protocol is untyped in JavaScript and the sent value is
  // whatever the caller passes. The generator lowering owns the channels.
  7057,
]);

/* Arithmetic on an `any` operand (TS2362/2363/2365 fire when the other
 * side is bigint-ish): plain JS — relaxed only when 'any' participates. */
export const JS_ANY_OPERATOR_CODES: ReadonlySet<number> = new Set([2362, 2363, 2365]);

/* ── The triage table for the SC0001 tail ──────────────────────────────
 *
 * Every other TypeScript code that reaches SC0001 in a JavaScript source
 * gets one decision here. The codes the W1.1/W1.2 relaxations own (2695,
 * 7032, 18050, 2508, 7057, 2704, 2464, 2365) are absent on purpose: they
 * are admitted by the sets above, not triaged here.
 *
 *   relax    legal JavaScript whose construct the lowering already builds
 *            Node-exactly. The code is admitted; every admitted code is
 *            proved by a differential corpus program.
 *   keep     Node rejects the program too (a JavaScript grammar or early
 *            error, or a ReferenceError/TypeError the language guarantees),
 *            so tsc's own text is the honest diagnostic and stays SC0001.
 *   refuse   legal JavaScript scriptc does not lower, and no lowering
 *            change is claimed: SC1090 names the construct.
 *   rewrite  legal JavaScript whose admission needs a lowering change:
 *            SC1090 names the construct today and marks the work.
 *
 * refuse and rewrite both emit a named SC1090 diagnostic at the
 * diagnostic's own location. A code cannot be relaxed and kept at once;
 * the table is exhaustive over the codes the Test262 journals observed
 * (tsc-codes.test.ts enforces that), so a new code cannot slip through
 * untriaged.
 */

export type JsTscCodeAction = "relax" | "refuse" | "rewrite" | "keep";

export type JsTscCodeTriage =
  /** Admitted: the construct already lowers to Node-exact behavior. */
  | { action: "relax"; why: string }
  /** Kept as SC0001: Node rejects this program too. */
  | { action: "keep"; why: string }
  /** SC1090 names an unlowered construct. */
  | { action: "refuse"; feature: string; hint: string }
  /** SC1090 names a construct whose lowering is still missing. */
  | { action: "rewrite"; feature: string; hint: string };

const KEEP_GRAMMAR =
  "a JavaScript grammar or early error: Node rejects this source with a SyntaxError, and tsc's text describes that rule";
const KEEP_EARLY_ERROR =
  "an early error whose runtime failure Node raises too (a ReferenceError or TypeError at the site); tsc's text names the rule";

const RELAX = (why: string): JsTscCodeTriage => ({ action: "relax", why });
const KEEP = (why: string): JsTscCodeTriage => ({ action: "keep", why });
const REFUSE = (feature: string, hint: string): JsTscCodeTriage => ({
  action: "refuse",
  feature,
  hint,
});
const REWRITE = (feature: string, hint: string): JsTscCodeTriage => ({
  action: "rewrite",
  feature,
  hint,
});

const TRIAGE_ROWS: readonly (readonly [number, JsTscCodeTriage])[] = [
  [1005, KEEP(KEEP_GRAMMAR)],
  [1010, KEEP(KEEP_GRAMMAR)],
  [1014, KEEP(KEEP_GRAMMAR)],
  [1042, KEEP(KEEP_GRAMMAR)],
  [1052, KEEP(KEEP_GRAMMAR)],
  [1054, KEEP(KEEP_GRAMMAR)],
  [1089, KEEP(KEEP_GRAMMAR)],
  [1101, KEEP(KEEP_GRAMMAR)],
  [1102, KEEP(KEEP_GRAMMAR)],
  [1104, KEEP(KEEP_GRAMMAR)],
  [1105, KEEP(KEEP_GRAMMAR)],
  [1106, KEEP(KEEP_GRAMMAR)],
  [1109, KEEP(KEEP_GRAMMAR)],
  [1113, KEEP(KEEP_GRAMMAR)],
  [1114, KEEP(KEEP_GRAMMAR)],
  [1117, KEEP(KEEP_GRAMMAR)],
  [1119, KEEP(KEEP_GRAMMAR)],
  [1121, KEEP(KEEP_GRAMMAR)],
  [1123, KEEP(KEEP_GRAMMAR)],
  [1125, KEEP(KEEP_GRAMMAR)],
  [1127, KEEP(KEEP_GRAMMAR)],
  [1134, KEEP(KEEP_GRAMMAR)],
  [1142, KEEP(KEEP_GRAMMAR)],
  [1156, KEEP(KEEP_GRAMMAR)],
  [1163, KEEP(KEEP_GRAMMAR)],
  [
    1166,
    REWRITE(
      "a computed class field name whose type is not a string, number, or symbol literal",
      "the class-field lowering needs the key computed at class-definition time, which is the value Node uses",
    ),
  ],
  [1189, KEEP(KEEP_GRAMMAR)],
  [1198, KEEP(KEEP_GRAMMAR)],
  [1200, KEEP(KEEP_GRAMMAR)],
  [1210, KEEP(KEEP_GRAMMAR)],
  [1214, KEEP(KEEP_GRAMMAR)],
  [1215, KEEP(KEEP_GRAMMAR)],
  [1260, KEEP(KEEP_GRAMMAR)],
  [1262, KEEP(KEEP_GRAMMAR)],
  [1312, KEEP(KEEP_GRAMMAR)],
  [
    1313,
    RELAX(
      "an empty statement as an 'if' body ('if (x) ;') is legal JavaScript, and the lowering emits nothing for the empty statement",
    ),
  ],
  [
    1320,
    REWRITE(
      "an 'await' operand the checker cannot prove is a promise",
      "Node awaits any value and ignores a non-callable 'then'; the await lowering needs the hostile-'then' path",
    ),
  ],
  [1329, KEEP(KEEP_GRAMMAR)],
  [1341, KEEP(KEEP_GRAMMAR)],
  [1359, KEEP(KEEP_GRAMMAR)],
  [1368, KEEP(KEEP_GRAMMAR)],
  [1451, KEEP(KEEP_GRAMMAR)],
  [1487, KEEP(KEEP_GRAMMAR)],
  [1488, KEEP(KEEP_GRAMMAR)],
  [1489, KEEP(KEEP_GRAMMAR)],
  [1492, KEEP(KEEP_GRAMMAR)],
  [1493, KEEP(KEEP_GRAMMAR)],
  [1494, KEEP(KEEP_GRAMMAR)],
  [1514, KEEP(KEEP_GRAMMAR)],
  [1532, KEEP(KEEP_GRAMMAR)],
  [1533, KEEP(KEEP_GRAMMAR)],
  [1534, KEEP(KEEP_GRAMMAR)],
  [1536, KEEP(KEEP_GRAMMAR)],
  [1539, KEEP(KEEP_GRAMMAR)],
  [2300, KEEP(KEEP_EARLY_ERROR)],
  [2335, KEEP(KEEP_GRAMMAR)],
  [2337, KEEP(KEEP_GRAMMAR)],
  [
    2348,
    REWRITE(
      "calling a class constructor without 'new'",
      "Node throws the 'Class constructor ... cannot be invoked without new' TypeError at the call",
    ),
  ],
  [
    2356,
    REFUSE(
      "arithmetic on an operand the checker types as non-numeric",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [2357, KEEP(KEEP_GRAMMAR)],
  [
    2359,
    REWRITE(
      "an 'instanceof' right operand that is not callable",
      "Node throws the 'Right-hand side of instanceof is not callable' TypeError at the expression",
    ),
  ],
  [2364, KEEP(KEEP_EARLY_ERROR)],
  [
    2372,
    REWRITE(
      "a parameter default that references its own parameter",
      "Node throws a ReferenceError when the parameter is initialized (the parameter environment's temporal dead zone)",
    ),
  ],
  [
    2373,
    REWRITE(
      "a parameter default that references a later parameter",
      "Node throws a ReferenceError when the parameter is initialized (the parameter environment's temporal dead zone)",
    ),
  ],
  [
    2377,
    REWRITE(
      "a derived constructor that never calls 'super'",
      "Node throws a ReferenceError when the constructor returns; the lowering needs the uninitialized-this path",
    ),
  ],
  [2378, RELAX("a 'get' accessor with no return path is legal JavaScript and answers undefined")],
  [2392, KEEP(KEEP_GRAMMAR)],
  [2393, KEEP(KEEP_GRAMMAR)],
  [
    2403,
    REWRITE(
      "a 'var' redeclared with a value of a different type",
      "the lowering pins the first declaration's storage type; a redeclaration must widen it (sloppy Annex B semantics)",
    ),
  ],
  [2405, KEEP(KEEP_GRAMMAR)],
  [2406, KEEP(KEEP_GRAMMAR)],
  [
    2407,
    REFUSE(
      "'for...in' over a value the checker types 'never'",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [2408, KEEP(KEEP_GRAMMAR)],
  [
    2409,
    REWRITE(
      "a constructor signature whose return type is not the instance type",
      "a JSDoc @constructor signature has to describe the instance it builds",
    ),
  ],
  [
    2416,
    REFUSE(
      "a subclass member whose type differs from its base's",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2417,
    REFUSE(
      "a subclass static side whose type differs from its base's",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2418,
    REFUSE(
      "a computed class member whose value type differs from the checker's expectation",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2447,
    RELAX("'&' on booleans is legal JavaScript: the operator converts both operands with ToInt32"),
  ],
  [
    2448,
    REWRITE(
      "a block-scoped variable read above its declaration",
      "Node throws a ReferenceError (the temporal dead zone); the lowering needs a TDZ-carrying binding",
    ),
  ],
  [2451, KEEP(KEEP_GRAMMAR)],
  [
    2454,
    REFUSE(
      "a 'var' read before its assignment",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2469,
    REWRITE(
      "the '+' operator on a symbol operand",
      "Node throws a TypeError ('Cannot convert a Symbol value to a string') at the operator",
    ),
  ],
  [2481, KEEP(KEEP_GRAMMAR)],
  [2487, KEEP(KEEP_GRAMMAR)],
  [
    2490,
    REWRITE(
      "an iterator whose 'next()' result the checker cannot prove carries a 'value' property",
      "the iteration protocols throw a TypeError when 'next()' returns a non-object",
    ),
  ],
  [2491, KEEP(KEEP_GRAMMAR)],
  [2492, KEEP(KEEP_EARLY_ERROR)],
  [
    2493,
    REWRITE(
      "reading an element of an empty tuple-typed array",
      "the read answers undefined in JavaScript; the tuple lowering must not assume the element exists",
    ),
  ],
  [
    2506,
    REWRITE(
      "a class whose 'extends' expression references the class itself",
      "Node throws a ReferenceError when the class is defined",
    ),
  ],
  [
    2511,
    REFUSE(
      "instantiating a class the declarations mark 'abstract'",
      "the class throws TypeErrors under Node's own semantics; declare a concrete subclass or construct the value in a Node island",
    ),
  ],
  [2524, KEEP(KEEP_GRAMMAR)],
  [
    2537,
    REFUSE(
      "an index read over a type with no matching index signature",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2539,
    REWRITE(
      "assigning to 'undefined'",
      "sloppy mode ignores the write and strict mode throws a TypeError; the lowering needs the mode-dependent path",
    ),
  ],
  [
    2542,
    REFUSE(
      "a write through a readonly index signature",
      "readonly is an annotation: whether the write succeeds or throws depends on the object's frozen state at run time, which the lowering does not model",
    ),
  ],
  [
    2547,
    REWRITE(
      "an async iterator whose 'next()' result the checker cannot prove is a promise for a 'value' object",
      "the async iteration protocol throws a TypeError when the promise resolves to a non-object",
    ),
  ],
  [
    2565,
    REFUSE(
      "reading 'prototype' before its assignment",
      "the declaration's definite-assignment rule; assign 'prototype' before the read",
    ),
  ],
  [
    2576,
    REFUSE(
      "an instance read of a member the checker knows only as static",
      "the instance read answers undefined in JavaScript; declare the member on the instance to read it, or reach the class object",
    ),
  ],
  [
    2588,
    REWRITE(
      "assigning to a 'const' binding",
      "Node throws a TypeError at the assignment (strict mode, and always in modules)",
    ),
  ],
  [
    2629,
    REWRITE(
      "assigning to a class name binding",
      "Node throws a TypeError at the assignment; the class binding is read-only",
    ),
  ],
  [
    2630,
    REWRITE(
      "assigning to a function declaration name",
      "Node throws a TypeError at the assignment in strict mode and modules",
    ),
  ],
  [2660, KEEP(KEEP_GRAMMAR)],
  [2662, KEEP(KEEP_GRAMMAR)],
  [2678, RELAX("comparing two literal values of different types is legal JavaScript")],
  [
    2684,
    REWRITE(
      "a call whose 'this' type the checker rejects",
      "JavaScript passes whatever receiver the expression produces; the this-context lowering is the remaining gap (W6)",
    ),
  ],
  [
    2698,
    RELAX(
      "object spread of null or undefined is legal JavaScript: the spread contributes no properties",
    ),
  ],
  [
    2699,
    REFUSE(
      "a static class member named 'prototype'",
      "Node throws a TypeError when the class is defined; rename the member",
    ),
  ],
  [
    2700,
    REWRITE(
      "a rest element over a null or undefined value",
      "Node throws a TypeError when the pattern is assigned",
    ),
  ],
  [
    2703,
    REWRITE(
      "the operand of 'delete' is not a property reference",
      "sloppy mode answers true and strict mode is a SyntaxError; the lowering needs the mode-dependent path",
    ),
  ],
  [
    2723,
    REFUSE(
      "a call to a value the checker types as possibly null or undefined",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2729,
    REWRITE(
      "a private field read before its initialization",
      "Node throws a TypeError at the read",
    ),
  ],
  [2736, REWRITE("unary '+' on a bigint", "Node throws a TypeError at the operator")],
  [
    2739,
    REFUSE(
      "a set-like argument the checker cannot prove implements 'has' and 'size'",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2767,
    REWRITE(
      "an iterator whose 'throw' property is not a method",
      "the iteration protocol throws a TypeError at the call",
    ),
  ],
  [
    2768,
    REWRITE(
      "an async iterator whose 'return' property is not a method",
      "the async iteration protocol throws a TypeError at the call",
    ),
  ],
  [
    2774,
    RELAX(
      "a function reference in a condition is legal JavaScript and truthy; the condition evaluates as written",
    ),
  ],
  [2777, KEEP(KEEP_GRAMMAR)],
  [
    2783,
    RELAX(
      "a later property or spread overwriting an earlier property is legal JavaScript, and the last write wins",
    ),
  ],
  [
    2803,
    REWRITE(
      "assigning to a private method",
      "Node throws a TypeError at the assignment; private methods are not writable",
    ),
  ],
  [2815, KEEP(KEEP_GRAMMAR)],
  [
    2839,
    REFUSE(
      "a comparison the checker proves constant (two object references)",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2845,
    REFUSE(
      "a comparison the checker proves constant (a bigint against a non-finite number)",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2850,
    REWRITE(
      "a 'using' initializer that is not disposable",
      "Node throws a TypeError when the declaration is initialized",
    ),
  ],
  [2855, KEEP(KEEP_GRAMMAR)],
  [
    2869,
    REFUSE(
      "the right operand of '??' the checker proves unreachable",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2871,
    REFUSE(
      "an expression the checker proves always nullish",
      "the construct is legal JavaScript: admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
    ),
  ],
  [
    2872,
    RELAX("an always-truthy expression is legal JavaScript; the condition evaluates as written"),
  ],
  [
    2873,
    RELAX("an always-falsy expression is legal JavaScript; the condition evaluates as written"),
  ],
  [
    4104,
    REFUSE(
      "assigning to a readonly array type",
      "readonly is an annotation: whether the write succeeds or throws depends on the array's frozen state at run time, which the lowering does not model",
    ),
  ],
  [5076, KEEP(KEEP_GRAMMAR)],
  [
    7036,
    REWRITE(
      "a dynamic import specifier that is not statically a string",
      "Node converts the specifier with ToString at run time, and the import lowering must follow",
    ),
  ],
  [17005, KEEP(KEEP_EARLY_ERROR)],
  [17009, KEEP(KEEP_EARLY_ERROR)],
  [17011, KEEP(KEEP_EARLY_ERROR)],
  [17013, KEEP(KEEP_EARLY_ERROR)],
  [18013, KEEP(KEEP_EARLY_ERROR)],
  [18014, KEEP(KEEP_EARLY_ERROR)],
  [18016, KEEP(KEEP_GRAMMAR)],
  [18030, KEEP(KEEP_EARLY_ERROR)],
  [18037, KEEP(KEEP_EARLY_ERROR)],
  [18041, KEEP(KEEP_EARLY_ERROR)],
  [18058, KEEP(KEEP_EARLY_ERROR)],
  [18059, KEEP(KEEP_EARLY_ERROR)],
  [18061, KEEP(KEEP_GRAMMAR)],
];

/** The triage of one TypeScript code that reaches SC0001 in a JavaScript
 * source, or null for a code this table does not cover (the W1.1/W1.2
 * admissions above, and codes no journal has observed). */
export const JS_TSC_CODE_TRIAGE: ReadonlyMap<number, JsTscCodeTriage> = new Map(TRIAGE_ROWS);

export function jsTscCodeTriage(code: number): JsTscCodeTriage | null {
  return JS_TSC_CODE_TRIAGE.get(code) ?? null;
}

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
