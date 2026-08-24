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
] as const;

/* The JAVASCRIPT strictness stance (the JS-input design made real):
 * JavaScript sources carry no annotations, so tsc's strictness families
 * that exist to demand annotations — or to reject dynamically-typed
 * idioms that are ordinary, working JS — cannot be satisfied by the
 * program's author at all. The design already says where inference gaps
 * land: exactly where `any` lands in TS (island under --dynamic, honest
 * fences without). So for JS FILES ONLY, these tsc families are not
 * preflight gates; the values involved stay `any`/loose and every use
 * meets the lowerer's per-site fences instead. TypeScript sources keep
 * the full strict gate — nothing here weakens the default for annotated
 * programs. */
export const JS_RELAXED_TSC_CODES: ReadonlySet<number> = new Set([
  // implicit any (params, variables, elements, this, returns, rest,
  // construct signatures, index reads over shapes with no index
  // signature — typeof globalThis)
  2683, 7005, 7006, 7008, 7009, 7010, 7015, 7017, 7019, 7022, 7023, 7024, 7031, 7034, 7053,
  // strict-null narrowing demands (possibly null/undefined receivers)
  2531, 2532, 2533, 18047, 18048, 18049,
  // assignability/arity/callability of dynamic call shapes (valid JS,
  // checked at runtime by Node; the lowerer re-checks every lowered form
  // per site) and member/existence probes over dynamic shapes (expando
  // properties, capability probes — the lowerer fences unknown members
  // per site with the SC2020 family)
  2322, 2339, 2345, 2349, 2351, 2367, 2554, 2555, 2556, 2769,
  2740, // 2322's elaborated "missing the following properties" form
  2305, 2551, 2724, 2731,
  // excess object-literal properties against a JSDoc-inferred contextual
  // type (and the did-you-mean variant): ordinary, working JS — the extra
  // key rides the object at runtime exactly as written (the formatter idiom's
  // expand-patterns passes an ignoreUnknown member its own JSDoc type
  // never declared)
  2353, 2561,
  // JSDoc TYPE-SPACE claims that fail to check: a value name in a type
  // position (2749/2702), generic constraints and index types spelled in
  // typedefs (2344/2536/2538), an async @returns that is not Promise
  // (1064), and 2366's no-ending-return against a JSDoc-declared return
  // type. The claims are documentation — Node never reads them; the
  // values keep their runtime behavior and every use meets the per-site
  // fences (the pattern's source carries dozens of each).
  2749, 2702, 2344, 2536, 2538, 1064, 2366,
  // strict-null demands on dynamic shapes, continued: iterating/invoking
  // possibly-undefined values (runtime re-checks at the site)
  2488, 2721, 2722,
  // an UNUSED @ts-expect-error: the directive annotated an error visible
  // under the project's OWN tsconfig world — scriptc's world deliberately
  // differs (adopted options, hidden declaration twins), and an unused
  // suppression changes nothing at runtime
  2578,
  // a lib-floor demand (es2024+ members under the es2023 lib): the member
  // types as the error-any and its use fences per site with the honest
  // no-lowering story instead of gating the whole program
  2550,
  // `export *` ambiguity (2308): Node DEFINES this case — ambiguous names
  // are excluded from the star surface — where tsc asks for an explicit
  // re-export; and 2305's did-you-mean sibling 2614 joins 2305
  2308, 2614,
  // 2740's sibling elaboration ("Property X is missing in type Y")
  2741,
  // unresolvable modules: Node throws WHEN the require executes — the
  // binding types as any and reached uses fence (never a silent pass)
  2307, 2792,
  // useUnknownInCatchVariables' annotation demand ("'e' is of type
  // 'unknown'", "Object is of type 'unknown'"): a JS catch clause CANNOT
  // annotate its variable, so the demand is unsatisfiable in source —
  // exactly the implicit-any story above. The values stay 'unknown' and
  // every use meets the lowerer's per-site unknown fences (member reads
  // ride the checked-dynamic tree; unsupported operations fence loudly).
  18046, 2571,
]);

/* Arithmetic on an `any` operand (TS2362/2363/2365 fire when the other
 * side is bigint-ish): plain JS — relaxed only when 'any' participates. */
export const JS_ANY_OPERATOR_CODES: ReadonlySet<number> = new Set([2362, 2363, 2365]);

/** True for JavaScript source file NAMES (.js/.mjs/.cjs/.jsx) — the files
 * whose types come entirely from inference (checkJs + JSDoc) and whose JS
 * relaxation stance applies. */
export function isJsSourceFileName(fileName: string): boolean {
  return /\.(js|mjs|cjs|jsx)$/.test(fileName);
}
