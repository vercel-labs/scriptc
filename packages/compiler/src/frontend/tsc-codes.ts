import * as ts from "./ts7/adapter.js";

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
 * allow), SC0009 (a private name with no declaring enclosing class),
 * SC0010 (an assignment target that is not a variable or property access),
 * SC0011 (`await` where the grammar makes it an operator), SC0012
 * (`arguments` in a class field initializer or static block), SC0013 (a
 * script-top-level `using` declaration), SC0014 (assignment to `eval` or
 * `arguments` in strict code), and SC0015 (a catch parameter the block
 * redeclares). A relaxation that needs one of those rules to keep firing
 * must land with the matching rule in that pass, not rely on this table. */

/* ── The JavaScript opinion table (read this before admitting a code) ───
 *
 * TypeScript's checker reports many diagnostics about constructs that are
 * legal JavaScript with a defined runtime meaning. For a JavaScript source,
 * scriptc treats such a diagnostic as an OPINION: a row in JS_OPINIONS says
 * what the lowering sees once the diagnostic is gone, and preflight drops
 * the diagnostic at every site where the row applies. Admission is keyed on
 * the SITE: preflight records (file, span, code) only where no other filter
 * already suppressed the diagnostic (program.ts, keptErrors), so a program
 * that admits nothing takes no path of its own.
 *
 * The views:
 *
 *   checker  the checker's type is still a truthful bound on every runtime
 *            value at and after the site; the ordinary lowering applies.
 *   widen    the checker's type would lie: the binding or member the
 *            diagnostic names holds values outside it, so its storage and
 *            its reads are checked-dynamic.
 *   throw    Node throws at the construct; the construct's own lowering
 *            emits that exception, with Node's class, message and
 *            evaluation order.
 *   island   sloppy-mode-only semantics: the module belongs in a Node
 *            island. Never admitted in strict code (isStrictCode, never
 *            tsc's module opinion: tsc treats every .cjs as strict).
 *
 * `site` guards where a code is broader than the construct the row covers
 * (7032 fires on public and private setters; 2348 on Buffer and on every
 * other class called without `new`). Such a code keeps its TRIAGE_ROWS row
 * as the decision for the sites the guard excludes; a code the row admits
 * everywhere appears in exactly one table, which tsc-codes.test.ts enforces.
 *
 * Scope: JavaScript sources only (isJsSourceFileName), checker diagnostics
 * only (a syntactic diagnostic leaves a recovered AST), and — D3 — unchecked
 * JavaScript only. A checked file (`// @ts-check`, `checkJs`) keeps what the
 * project asked tsc to see; codes a checked project has always seen carry
 * `checkedJs: "enforce"`.
 *
 * `corpus` names the differential programs that pin the row against Node.
 * The rows migrated from the earlier mechanisms (the relaxed sets and the
 * triage `relax` rows) name a program where one exists; a row without one is
 * admitted on its existing evidence and is the first thing a new slice
 * should pin.
 */
export type OpinionView = "checker" | "widen" | "throw" | "island";

export interface Opinion {
  readonly view: OpinionView;
  /** The row admits only the constructs this guard accepts at the
   * diagnostic's node. The program is the one the diagnostic came from, for
   * a guard that asks the checker about the node's types. */
  readonly site?: (node: ts.Node, diagnostic: ts.Diagnostic, program: ts.Program) => boolean;
  /** Keep the diagnostic in checked JavaScript: the project asked tsc for
   * this opinion. */
  readonly checkedJs?: "enforce";
  /** Differential corpus programs that pin the admitted construct against
   * Node. */
  readonly corpus: readonly string[];
  readonly why: string;
}

/** One admitted site: a JavaScript checker diagnostic preflight dropped
 * under an opinion row. A view's lowering path is reached only through such
 * a record (lowerer.opinionAt), never by a syntactic pattern, so a program
 * that compiles today without one keeps its IR byte for byte. */
export interface AdmittedOpinion {
  readonly file: string;
  readonly pos: number;
  readonly end: number;
  readonly code: number;
  readonly view: OpinionView;
}

const CHECKER = (why: string, corpus?: readonly string[]): Opinion => ({
  view: "checker",
  why,
  corpus: corpus ?? [],
});

/** `widen`: the diagnostic names a binding or member whose storage and reads
 * become checked-dynamic (jsWidenedBindings / runtimeOptionalBindingTypes). */
const WIDEN = (why: string, corpus?: readonly string[]): Opinion => ({
  view: "widen",
  why,
  corpus: corpus ?? [],
});

/** `throw`: the site lowers to Node's exception. */
const THROW = (why: string, corpus?: readonly string[]): Opinion => ({
  view: "throw",
  why,
  corpus: corpus ?? [],
});

/** The row applies only where its guard holds; the code's TRIAGE_ROWS row
 * stays for every other site. */
const at = (
  site: (node: ts.Node, diagnostic: ts.Diagnostic, program: ts.Program) => boolean,
  row: Opinion,
): Opinion => ({ ...row, site });

/** A checked JavaScript file keeps this diagnostic. */
const inCheckedJs = (row: Opinion): Opinion => ({ ...row, checkedJs: "enforce" });

/* ---- the site guards ---- */

/** TS7032 on a PRIVATE setter stays reported: the private-element lowering
 * does not implement the shadowing and brand-check rules those programs
 * exercise, so the program keeps refusing until that lowering exists. */
const notPrivateName = (node: ts.Node, d: ts.Diagnostic): boolean =>
  !ts.isPrivateIdentifier(node) && !ts.getSourceFileOfNode(node).text.startsWith("#", d.pos ?? -1);

/** TS1533/TS1534 report a decimal escape (`\1`, `\8`) that names no
 * capture group, and TS1536 one inside a character class (`[\1]`). Without
 * the `u` or `v` flag, JavaScript reads such an escape as a legacy octal or
 * identity escape (Annex B), so `/\1/` matches "\x01" and its source can
 * be reused in a pattern that has the group. With either flag the escape
 * is a SyntaxError, and the grammar row stays. */
const nonUnicodeRegexLiteral = (node: ts.Node): boolean => {
  if (!ts.isRegularExpressionLiteral(node)) return false;
  const flags = node.text.slice(node.text.lastIndexOf("/") + 1);
  return !flags.includes("u") && !flags.includes("v");
};

/** TS2362/2363/2365 fire on an operator whose other operand is bigint-ish;
 * plain JavaScript admits the `any` operand, a primitive wrapper operand
 * (`new Number(1) * 2`) converts with ToPrimitive like any object, and a
 * BigInt operand (`5n % 2n`, `0n | 1`, `{} >> 1n`, `1n < 1`) names the
 * operator's own BigInt form — or the TypeError a mixed, Symbol or `>>>`
 * operand throws. Both operands undergo ToNumeric (or ToPrimitive for a
 * comparison) first, which is the order the checked-dynamic arithmetic,
 * bitwise and comparison lowering applies, so each shape is answerable —
 * including an operand that answers through Symbol.toPrimitive, which the
 * runtime applies ahead of valueOf/toString whichever way the key is
 * spelled (`{[Symbol.toPrimitive]: () => 9n} % 5n` answers `4n`, as Node
 * does).
 *
 * A compound assignment on a BigInt target is the exception. Node reads the
 * target, applies the operator and stores whatever came back, so a partner
 * that answers a string turns the binding into a string (`1n + {}` is
 * "1[object Object]", so `x += {}` leaves a string in `x`), and any other
 * partner reaches the mixed-type TypeError. The lowering's BigInt arms take
 * two BigInts, so the assignment would either check a string result against
 * BigInt storage or raise the compiler's own refusal at run time; tsc's
 * refusal stays for every compound assignment on a BigInt target. */
const coercibleOperatorOperand = (
  node: ts.Node,
  d: ts.Diagnostic,
  program: ts.Program,
): boolean => {
  const text = ts.flattenDiagnosticMessageText(d, "\n");
  const coercible =
    text.includes("'any'") ||
    /'(Number|String|Boolean)'/.test(text) ||
    /\bbigint\b/.test(text) ||
    /\d+n\b/.test(text);
  return coercible && !bigintCompoundTarget(node, program);
};

/** Whether `node` sits in a compound assignment (`+=`, `-=`, ...) whose
 * target is a BigInt binding. */
const bigintCompoundTarget = (node: ts.Node, program: ts.Program): boolean => {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isBinaryExpression(current)) current = current.parent;
  if (current === undefined) return false;
  const operator = current.operatorToken.kind;
  if (operator <= ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment)
    return false;
  const checker = program.getTypeChecker();
  return (checker.getTypeAtLocation(current.left).flags & ts.TypeFlags.BigIntLike) !== 0;
};

/** TS2469 names the operator. `'' + sym` and `sym += ''` perform ToString,
 * which the lowering sends through the runtime conversion that throws Node's
 * TypeError; `~sym` and `-sym` keep the triage's refusal because their
 * lowered form would raise a different message. */
const symbolStringOperator = (_node: ts.Node, d: ts.Diagnostic): boolean => {
  const text = ts.flattenDiagnosticMessageText(d, "\n");
  return (
    (text.includes("The '+' operator") || text.includes("The '+=' operator")) &&
    text.includes("'symbol'")
  );
};

/** An index write on a String wrapper (`new String("ab")[5] = "q"`): Node
 * adds the property past the end and ignores writes to the read-only index
 * properties (sloppy) or throws (strict), as the object does. A write
 * through any other readonly index signature keeps tsc's refusal. */
const stringWrapperReceiver = (_node: ts.Node, d: ts.Diagnostic): boolean =>
  ts.flattenDiagnosticMessageText(d, "\n").includes("type 'String'");

/** The deprecated `Buffer(...)` call without `new`, which Node's Buffer
 * function accepts (containers/bytes.ts lowers it), `fs.ReadStream(...)` /
 * `fs.WriteStream(...)`, which construct their stream
 * (builtins/fs-streams.ts), and `Iterator()` (2348), which throws Node's
 * TypeError at the call (iterator-prototype.ts). Every other class called
 * without `new` keeps the triage's SC1090. */
const deprecatedBufferCall = (_node: ts.Node, d: ts.Diagnostic): boolean => {
  const text = ts.flattenDiagnosticMessageText(d, "\n");
  return (
    text.includes("'BufferConstructor'") ||
    text.includes("'typeof ReadStream'") ||
    text.includes("'typeof WriteStream'") ||
    text.includes("'IteratorConstructor'")
  );
};

/** TS17013 inside a method or accessor body (including an arrow nested in
 * one): `new.target` is legal there and always undefined, because a method is
 * not constructable. The path must enter the member through its body or a
 * parameter, which run in the method's function scope; a computed member name
 * is evaluated outside it. Global code and class field initializers keep the
 * early SyntaxError the specification makes them. */
const newTargetInMethod = (node: ts.Node, _d: ts.Diagnostic): boolean => {
  let child: ts.Node = node;
  for (let p: ts.Node | undefined = node.parent; p !== undefined; child = p, p = p.parent) {
    if (ts.isArrowFunction(p)) continue;
    if (
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    )
      return (
        p.body === child || p.parameters?.nodes.includes(child as ts.ParameterDeclaration) === true
      );
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
};

/** TS1345 at a PREFIX `!` whose boolean is discarded (`!register();`,
 * `!function () { … }();`): the operand still evaluates once for its
 * effects and any exception, while the value the negation would read is
 * never consumed. A negation whose result is used — an initializer, a
 * condition, a logical operand — keeps the diagnostic, because converting a
 * value the checker types `void` needs a runtime value the lowering does
 * not model. */
const discardedVoidNegation = (node: ts.Node): boolean => {
  // The diagnostic's span is the void-typed OPERAND (the call), so climb
  // to the `!` that tests it, then out of any parentheses.
  let operand: ts.Node = node;
  while (operand.parent !== undefined && ts.isParenthesizedExpression(operand.parent))
    operand = operand.parent;
  const negation = operand.parent;
  if (
    negation === undefined ||
    !ts.isPrefixUnaryExpression(negation) ||
    negation.operator !== ts.SyntaxKind.ExclamationToken
  )
    return false;
  let outer: ts.Node = negation;
  while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
    outer = outer.parent;
  return outer.parent !== undefined && ts.isExpressionStatement(outer.parent);
};

/* ---- family reasons ---- */

const IMPLICIT_ANY =
  "a JavaScript value with no annotation is whatever the caller passes: Node has no types to check, and the lowering maps the value dynamically";
const NULLISH_DEMAND =
  "strict-null's demand is an inference, not a rule: Node reads whatever the value is, and the use site re-checks or throws as Node does";
const DYNAMIC_SHAPE =
  "assignability, arity and callability of an inferred shape are checker opinions: Node calls the value, and the lowering re-checks every lowered form per site";
const JSDOC_CLAIM =
  "a JSDoc type-space claim is documentation Node never reads: the values keep their runtime behavior and every use meets the per-site fences";

const LEGACY_REGEX_ESCAPE = at(
  nonUnicodeRegexLiteral,
  CHECKER(
    "a decimal escape without a matching group, or inside a character class, is a legacy octal or identity escape in a regex literal without the u or v flag",
    ["tests/corpus/regexp-legacy-decimal-escapes.mjs"],
  ),
);

const OPINION_ROWS: readonly (readonly [number, Opinion])[] = [
  // legacy decimal escapes in non-Unicode regex literals
  [1533, LEGACY_REGEX_ESCAPE],
  [1534, LEGACY_REGEX_ESCAPE],
  [1536, LEGACY_REGEX_ESCAPE],
  // implicit any (params, variables, elements, this, returns, rest,
  // construct signatures, index reads over shapes with no index signature —
  // typeof globalThis)
  [
    2683,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/emitter-listener-this.cjs",
      "tests/corpus/timers-callback-this.cjs",
    ]),
  ],
  [
    7005,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/8799-js-promise-statics-foreign-this.js",
      "tests/corpus/7058-pipeline-function-stages.mjs",
    ]),
  ],
  [
    7006,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/7752-typed-array-dynamic-methods.js",
      "tests/corpus/5548-fs-callback-arguments.cjs",
    ]),
  ],
  [
    7008,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/js-declared-fields.cjs",
      "tests/corpus/js-inherited-field-storage.js",
    ]),
  ],
  [
    7009,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/6562-constructor-function-transform.cjs",
      "tests/corpus/es5-constructor-inspect-names.cjs",
    ]),
  ],
  [7010, CHECKER(IMPLICIT_ANY)],
  [
    7015,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/buffer-computed-members.js",
      "tests/corpus/buffer-fs-member-reads.js",
    ]),
  ],
  [
    7017,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/7485-global-object-own-properties.js",
      "tests/corpus/global-stored-probes.js",
    ]),
  ],
  [
    7019,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/2567-rest-spread-forward.js",
      "tests/corpus/2568-rest-spread-forward-dynamic.js",
    ]),
  ],
  [
    7022,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/5114-var-hoisting-js.js",
      "tests/corpus/1760-surplus-args-drop.cjs",
    ]),
  ],
  [
    7023,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/error-prototype-tostring.js",
      "tests/corpus/function-custom-prototype.js",
    ]),
  ],
  [
    7024,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/7450-crypto-x25519.mjs",
      "tests/corpus/7449-crypto-raw-keys.mjs",
    ]),
  ],
  [
    7031,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/inferred-partial-destructuring.mjs",
      "tests/corpus/7437-duplex-from-signal.mjs",
    ]),
  ],
  [
    7034,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/8799-js-promise-statics-foreign-this.js",
      "tests/corpus/5547-fs-write-stream.cjs",
    ]),
  ],
  [
    7053,
    CHECKER(IMPLICIT_ANY, [
      "tests/corpus/1731-symbol-field-shapes.cjs",
      "tests/corpus/global-symbol-cache/main.js",
    ]),
  ],
  // strict-null narrowing demands (possibly null/undefined receivers) and
  // the possibly-undefined values iterated or invoked
  [
    2531,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/8702-js-primitive-object-coercion.js",
      "tests/corpus/js-module-function-values.js",
    ]),
  ],
  [
    2532,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/8905-groupby-dynamic-sources.js",
      "tests/corpus/5923-matchall-groups-js.js",
    ]),
  ],
  [2533, CHECKER(NULLISH_DEMAND)],
  [
    18047,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/fetch-body-web-stream-linked.mjs",
      "tests/corpus/8799-js-promise-statics-foreign-this.js",
    ]),
  ],
  [
    18048,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/5923-matchall-groups-js.js",
      "tests/corpus/8079-descriptor-object-shapes.cjs",
    ]),
  ],
  [18049, CHECKER(NULLISH_DEMAND, ["tests/corpus/5303-stream-finished-callback-opts.cjs"])],
  [
    2488,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/2602-dyn-array-destructure.js",
      "tests/corpus/8603-destructuring-catch-bindings.cjs",
    ]),
  ],
  [2721, CHECKER(NULLISH_DEMAND, ["tests/corpus/8702-js-primitive-object-coercion.js"])],
  [
    2722,
    CHECKER(NULLISH_DEMAND, [
      "tests/corpus/5909-iterator-helper-objects-js.js",
      "tests/corpus/6072-iterator-sources-js.js",
    ]),
  ],
  // assignability/arity/callability of dynamic call shapes (valid JS,
  // checked at runtime by Node; the lowerer re-checks every lowered form
  // per site) and member/existence probes over dynamic shapes (expando
  // properties, capability probes — the lowerer fences unknown members per
  // site with the SC2020 family). 2322/2345/2554/2555/2556/2559/2740/2741/
  // 2769 are CODE-checked JavaScript's: a checked file keeps them.
  [
    2322,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/webassembly-jsapi.mjs",
        "tests/corpus/webassembly-wpt-jsapi.mjs",
      ]),
    ),
  ],
  [
    2339,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/5548-fs-callback-arguments.cjs",
      "tests/corpus/5549-fs-callback-option-checks.cjs",
    ]),
  ],
  [
    2345,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/webassembly-wpt-jsapi.mjs",
        "tests/corpus/3035-string-positioned-search-value.js",
      ]),
    ),
  ],
  [
    2349,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/webassembly-api.mjs",
      "tests/corpus/webassembly-jsapi.mjs",
    ]),
  ],
  [
    2351,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/6915-dynamic-builtin-construct.mjs",
      "tests/corpus/typed-array-constructor-values.mjs",
    ]),
  ],
  [
    2367,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/stdio-values.mjs",
      "tests/corpus/js-array-default-buffer.js",
    ]),
  ],
  [
    2554,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/2571-searchparams-arg-validation.cjs",
        "tests/corpus/2597-dgram-send-ladders.cjs",
      ]),
    ),
  ],
  [
    2555,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/js-array-proto-array-likes.js",
        "tests/corpus/3044-array-slice-splice-positions.js",
      ]),
    ),
  ],
  [
    2556,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/5216-perf-spread-arguments.js",
        "tests/corpus/class-super-surplus-spread.mjs",
      ]),
    ),
  ],
  [
    2769,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/7445-crypto-key-pair-options.mjs",
        "tests/corpus/5254-cipher-errors.js",
      ]),
    ),
  ],
  [
    2740,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/6295-jose-hs256/main.mjs",
        "tests/corpus/js-array-default-buffer.js",
      ]),
    ),
  ], // 2322's elaborated form
  [
    2741,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/webassembly-jsapi.mjs",
        "tests/corpus/5446-crypto-secret-key-errors.js",
      ]),
    ),
  ], // 2740's sibling elaboration
  [
    2559,
    inCheckedJs(
      CHECKER(DYNAMIC_SHAPE, [
        "tests/corpus/7154-crypto-cipher-info.cjs",
        "tests/corpus/5338-stream-operators-checks.cjs",
      ]),
    ),
  ],
  [
    2305,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/6431-cjs-exports-rebinding/main.cjs",
      "tests/corpus/buffer-slowbuffer.cjs",
    ]),
  ],
  [
    2551,
    CHECKER(DYNAMIC_SHAPE, [
      "tests/corpus/2595-fs-arg-ladders.cjs",
      "tests/corpus/6704-ecdh-set-public-key.cjs",
    ]),
  ],
  [2724, CHECKER(DYNAMIC_SHAPE)],
  [2731, CHECKER(DYNAMIC_SHAPE, ["tests/corpus/native-proxy-env.js"])],
  // excess object-literal properties against a JSDoc-inferred contextual
  // type (and the did-you-mean variant): ordinary, working JS — the extra
  // key rides the object at runtime exactly as written (the formatter
  // idiom's expand-patterns passes an ignoreUnknown member its own JSDoc
  // type never declared)
  [
    2353,
    CHECKER(JSDOC_CLAIM, [
      "tests/corpus/5440-crypto-hash-encodings.js",
      "tests/corpus/5939-js-let-object-reassigned-wider.js",
    ]),
  ],
  [2561, CHECKER(JSDOC_CLAIM)],
  // JSDoc TYPE-SPACE claims that fail to check: a value name in a type
  // position (2749/2702), generic constraints and index types spelled in
  // typedefs (2344/2536/2538), an async @returns that is not Promise
  // (1064), and 2366's no-ending-return against a JSDoc-declared return
  // type.
  [2749, CHECKER(JSDOC_CLAIM)],
  [2702, CHECKER(JSDOC_CLAIM)],
  [2344, CHECKER(JSDOC_CLAIM)],
  [2536, CHECKER(JSDOC_CLAIM)],
  [
    2538,
    CHECKER(JSDOC_CLAIM, [
      "tests/corpus/8986-js-dynamic-key-element-read.js",
      "tests/corpus/process-env-computed-keys.js",
    ]),
  ],
  [1064, CHECKER(JSDOC_CLAIM)],
  [2366, CHECKER(JSDOC_CLAIM, ["tests/corpus/js-object-receiver-storage.js"])],
  // The async-iterator protocol demand (2504). Whether a value is
  // async-iterable is a runtime fact of untyped JS, exactly like the sync
  // demand: `for await` over a non-iterable value and `yield*` in an async
  // generator both lower through the runtime protocol openers, which read
  // the method, call it, and throw TypeError at the site when it is missing,
  // uncallable, or returns a non-object — the same protocol failure Node
  // reports. 2505 is the sync sibling on the typed lowering lanes and stays
  // enforced.
  [
    2504,
    CHECKER(
      "iteration membership is a runtime fact of untyped JS; the protocol openers read the method and throw Node's TypeError at the site",
    ),
  ],
  // An UNUSED @ts-expect-error: the directive annotated an error visible
  // under the project's OWN tsconfig world — scriptc's world deliberately
  // differs (adopted options, hidden declaration twins), and an unused
  // suppression changes nothing at runtime.
  [
    2578,
    CHECKER(
      "an unused @ts-expect-error annotated an error only the project's own world has; nothing changes at runtime",
    ),
  ],
  // A primitive on the left of instanceof (`"x" instanceof String`): Node
  // answers false, which the lowering folds.
  [
    2358,
    CHECKER("a primitive operand's instanceof answers false, which the lowering folds", [
      "tests/corpus/8868-class-static-has-instance-hook.js",
      "tests/corpus/js-primitive-wrappers.js",
    ]),
  ],
  // A lib-floor demand (es2024+ members under the es2023 lib): the member
  // types as the error-any and its use fences per site with the honest
  // no-lowering story instead of gating the whole program.
  [
    2550,
    CHECKER(
      "a lib-floor demand over a member the runtime may have: the member types as the error-any and its use fences per site",
    ),
  ],
  // `export *` ambiguity (2308): Node DEFINES this case — ambiguous names
  // are excluded from the star surface — where tsc asks for an explicit
  // re-export; and 2305's did-you-mean sibling 2614 joins 2305.
  [
    2308,
    CHECKER(
      "Node defines an ambiguous `export *`: the ambiguous names are excluded from the star surface",
    ),
  ],
  [
    2614,
    CHECKER("the did-you-mean spelling of a member the lowering resolves or fences at the site"),
  ],
  // JavaScript subclasses may widen fields or add method parameters. Class
  // lowering checks native storage and override ABIs at each use.
  [
    2415,
    inCheckedJs(
      CHECKER(
        "a JavaScript subclass may widen a field or add parameters; class lowering checks storage and override ABIs at each use",
        [
          "tests/corpus/cjs-symbol-key-table/main.js",
          "tests/corpus/js-nullish-inherited-fields.mjs",
        ],
      ),
    ),
  ],
  // A private or protected constructor (`new readline.Interface(...)`, whose
  // declaration is protected): JavaScript has no constructor accessibility,
  // and Node constructs the class. Each `new` meets the lowerer's per-site
  // constructor fences.
  [
    2673,
    CHECKER(
      "JavaScript has no constructor accessibility: Node constructs the class, and each `new` meets the per-site constructor fences",
    ),
  ],
  [
    2674,
    CHECKER(
      "JavaScript has no constructor accessibility: Node constructs the class, and each `new` meets the per-site constructor fences",
      ["tests/corpus/8230-readline-interface-constructor.cjs"],
    ),
  ],
  // Unresolvable modules: Node throws WHEN the require executes — the
  // binding types as any and reached uses fence instead of passing
  // unchecked.
  [
    2307,
    CHECKER(
      "an unresolvable module fails when Node loads it: the binding types as any and reached uses fence",
      [
        "tests/corpus/dynamic-import-not-found.mjs",
        "tests/corpus/2195-require-missing-package/main.mjs",
      ],
    ),
  ],
  [
    2792,
    CHECKER(
      "an unresolvable module fails when Node loads it: the binding types as any and reached uses fence",
    ),
  ],
  // A write to a property declarations mark readonly (2540): `readonly` is a
  // type annotation that Node never sees (Next.js's types mark
  // process.env.NODE_ENV readonly; its server.js assigns it); the write
  // lowers like any other and keeps its runtime behavior.
  [
    2540,
    CHECKER(
      "`readonly` is an annotation Node never sees: the write lowers like any other and keeps its runtime behavior",
    ),
  ],
  // A resolved JavaScript module without declarations (7016): Node loads it
  // like any other module; deployment trees such as Next.js standalone
  // output ship runtime files only, so the binding types as any and its uses
  // take the dynamic paths, as for 2307.
  [
    7016,
    CHECKER(
      "a resolved JavaScript module without declarations loads like any other: the binding types as any and its uses take the dynamic paths",
      [
        "tests/corpus/6882-node-island-nested-require/main.js",
        "tests/corpus/6880-node-island-cjs-entry/main.js",
      ],
    ),
  ],
  // `delete` of a property the inference typed required (2790): JS deletes
  // any configurable property, and the lowering checks each delete's
  // receiver itself.
  [
    2790,
    CHECKER(
      "JS deletes any configurable property; the lowering checks each delete's receiver itself",
      ["tests/corpus/8066-object-hasown-delete.cjs", "tests/corpus/object-literal-members.mjs"],
    ),
  ],
  // useUnknownInCatchVariables' annotation demand ("'e' is of type
  // 'unknown'"): a JS catch clause CANNOT annotate its variable, so the
  // demand is unsatisfiable in source — exactly the implicit-any story. The
  // values stay 'unknown' and every use meets the lowerer's per-site unknown
  // fences.
  [
    18046,
    CHECKER(
      "a JS catch clause cannot annotate its variable: the demand is unsatisfiable in source, and every use meets the per-site unknown fences",
      [
        "tests/corpus/process-builtin-values.js",
        "tests/corpus/7545-string-regex-checked-arguments.js",
      ],
    ),
  ],
  [
    2571,
    CHECKER(
      "a JS catch clause cannot annotate its variable: the demand is unsatisfiable in source, and every use meets the per-site unknown fences",
      ["tests/corpus/3100-json-callback-holder.js", "tests/corpus/logical-assignment-dynamic.js"],
    ),
  ],
  // UNDECLARED NAMES in a JavaScript source: Node resolves them at run time,
  // never at compile time — a READ throws the catchable
  // `ReferenceError: <name> is not defined` at the access (`typeof` of one
  // answers "undefined"), and a sloppy-mode WRITE creates a global. The
  // lowerer turns the read into `scr_undef_global_read` (exact Node text and
  // behavior) and refuses the write with SC1091, which names the Node-island
  // route the sloppy semantics need. TypeScript input keeps the compile
  // error: an undeclared name there is a bug, not a runtime path, unless a
  // library the project's `lib` names declares it and Node defines no such
  // global (program.ts, projectLibraryName admits those sites). 2552 is
  // 2304's did-you-mean spelling, 2584 its spelling for a name another
  // library declares (`document`, `window`: Node defines neither), and
  // 18004 is the same unresolved name in SHORTHAND position (`{ x }`), which
  // the checker reports against the property instead of the reference.
  [
    2304,
    THROW(
      "a read of an undeclared name throws Node's ReferenceError at the access (typeof answers 'undefined'); a sloppy write is SC1091",
      ["tests/corpus/8427-sloppy-with-island/main.js", "tests/corpus/8515-js-undeclared-read.js"],
    ),
  ],
  [
    2552,
    THROW(
      "a read of an undeclared name throws Node's ReferenceError at the access (typeof answers 'undefined'); a sloppy write is SC1091",
    ),
  ],
  [
    2584,
    THROW(
      "a read of an undeclared name throws Node's ReferenceError at the access (typeof answers 'undefined'); a sloppy write is SC1091",
      ["tests/corpus/8941-js-host-name-read.js", "tests/corpus/global-detection-typeof.cjs"],
    ),
  ],
  [
    18004,
    THROW(
      "a read of an undeclared name throws Node's ReferenceError at the access (typeof answers 'undefined'); a sloppy write is SC1091",
      ["tests/corpus/8515-js-undeclared-read.js"],
    ),
  ],
  // ---- The checker's OPINIONS about legal JavaScript ----
  // Each diagnostic below reports that a construct is unusual for TypeScript,
  // never that it is illegal JavaScript: Node gives it a defined runtime
  // meaning and the lowerer already builds it. TypeScript input keeps every
  // one of them.
  //
  // 2695, an unused comma-operand left side (`(0, fn)`, `(0, [[x]] = [])`):
  // the operator evaluates the left operand for its effects and yields the
  // right one; the lowerer emits a sequence expression for it.
  [
    2695,
    CHECKER(
      "the comma operator evaluates its left operand for effects and yields the right one, which the lowerer emits as a sequence",
      ["tests/corpus/8700-js-comma-operands.js"],
    ),
  ],
  // 18050, `null`/`undefined` in an arithmetic or bitwise position
  // (`null + undefined`, `null * 3`): ToNumber gives them 0 and NaN, which
  // the numeric coercion implements for a unit literal; the demand comes
  // from strictNullChecks, not from JavaScript.
  [
    18050,
    CHECKER(
      "ToNumber gives null 0 and undefined NaN; the demand comes from strictNullChecks, not from JavaScript",
      ["tests/corpus/8702-js-nullish-arithmetic.js"],
    ),
  ],
  // 7057, a `yield` in a generator with no return-type annotation: the
  // generator protocol is untyped in JavaScript and the sent value is
  // whatever the caller passes. The generator lowering owns the channels.
  [
    7057,
    CHECKER(
      "an untyped generator's sent value is whatever the caller passes; the generator lowering owns the channels",
      ["tests/corpus/8703-js-untyped-generators.js"],
    ),
  ],
  // 7032, a set accessor whose parameter has no type annotation: a
  // JavaScript setter's parameter is whatever the caller passes. The
  // lowering gives the parameter checked-dynamic storage (`paramShape`), and
  // a read of it stays dynamic rather than checking the caller's value back
  // into the type the checker inferred from a twin getter
  // (jsWidenedBindings), so the stored value keeps its runtime identity. A
  // JSDoc `@param` type is an annotation like any other and keeps its
  // declared storage.
  [
    7032,
    at(
      notPrivateName,
      WIDEN(
        "a JavaScript setter's parameter is whatever the caller passes; its storage is checked-dynamic and a read keeps the stored value",
        ["tests/corpus/8701-js-setter-implicit-any.js"],
      ),
    ),
  ],
  // tsgo's strict CommonJS modeling fires these on JS shapes 5.9.3 accepted,
  // and the real hazards those shapes carry are fenced by scriptc's OWN
  // analysis, never by these codes — so for JS FILES ONLY they join the
  // opinions (TS sources keep the full gate; the order-parity harness holds
  // both lanes to identical verdicts, so a case where 5.9.3 itself raises one
  // of these on a JS file would fail there, not slip by):
  //  - TS2309 ("export assignment with other exported elements") on the
  //    table-then-member pattern — cjsExportDiscardReason names every export
  //    Node actually discards.
  //  - TS2323 ("cannot redeclare exported variable") on symbol-keyed expando
  //    assignments in CJS classes (`this[kSym] = v` under `module.exports =
  //    Class`) — 5.9.3 synthesized expando symbols, tsgo trips its
  //    redeclaration check instead (the corpus's countdown fixture).
  // Ordinary JavaScript functions are constructable even when the checker
  // retains only their call signature after a factory return. Heritage
  // lowering separately verifies the actual constructor implementation
  // (2507).
  [
    2309,
    CHECKER(
      "Node discards the export assignment's siblings by its own rules, which cjsExportDiscardReason names",
      [
        "tests/corpus/6151-cjs-export-chains/main.js",
        "tests/corpus/6431-cjs-exports-rebinding/main.cjs",
      ],
    ),
  ],
  [
    2323,
    CHECKER(
      "a symbol-keyed expando assignment under module.exports redeclares nothing at runtime",
      [
        "tests/corpus/cjs-symbol-key-table/main.js",
        "tests/corpus/cjs-symbol-key-collisions/main.js",
      ],
    ),
  ],
  [
    2507,
    CHECKER(
      "an ordinary JavaScript function is constructable; heritage lowering verifies the constructor implementation",
      [
        "tests/corpus/class-factory-inherited-statics.mjs",
        "tests/corpus/6020-class-extends-function-constructor.js",
      ],
    ),
  ],
  // The SC0001 triage's `relax` rows: legal JavaScript whose construct the
  // lowering already builds Node-exactly. One corpus program pins them all.
  [
    1313,
    CHECKER(
      "an empty statement as an 'if' body is legal JavaScript, and the lowering emits nothing for it",
      ["tests/corpus/8732-jsts-triage-relax/main.mjs"],
    ),
  ],
  [
    2378,
    CHECKER("a 'get' accessor with no return path is legal JavaScript and answers undefined", [
      "tests/corpus/8732-jsts-triage-relax/main.mjs",
    ]),
  ],
  [
    2447,
    CHECKER(
      "'&' on booleans is legal JavaScript: the operator converts both operands with ToInt32",
      ["tests/corpus/8732-jsts-triage-relax/main.mjs"],
    ),
  ],
  [
    2678,
    CHECKER("comparing two literal values of different types is legal JavaScript", [
      "tests/corpus/8732-jsts-triage-relax/main.mjs",
    ]),
  ],
  [
    2698,
    CHECKER(
      "object spread of null or undefined is legal JavaScript: the spread contributes no properties",
      ["tests/corpus/8732-jsts-triage-relax/main.mjs"],
    ),
  ],
  [
    2774,
    CHECKER(
      "a function reference in a condition is legal JavaScript and truthy; the condition evaluates as written",
      ["tests/corpus/8732-jsts-triage-relax/main.mjs"],
    ),
  ],
  [
    2783,
    CHECKER(
      "a later property or spread overwriting an earlier property is legal JavaScript, and the last write wins",
      ["tests/corpus/8732-jsts-triage-relax/main.mjs"],
    ),
  ],
  [
    2872,
    CHECKER("an always-truthy expression is legal JavaScript; the condition evaluates as written", [
      "tests/corpus/8732-jsts-triage-relax/main.mjs",
    ]),
  ],
  [
    2873,
    CHECKER("an always-falsy expression is legal JavaScript; the condition evaluates as written", [
      "tests/corpus/8732-jsts-triage-relax/main.mjs",
    ]),
  ],
  // Arithmetic whose other operand is bigint-ish: admitted only for an `any`
  // or a primitive wrapper operand (TS2362/2363/2365; the code's TRIAGE row,
  // where one exists, keeps the typed operand).
  [
    2362,
    at(
      coercibleOperatorOperand,
      CHECKER(
        "an 'any', wrapper or BigInt operand is plain JavaScript: the operator converts both with ToPrimitive/ToNumeric first",
        ["tests/corpus/js-primitive-wrappers.js", "tests/corpus/js-primitive-wrappers-zero-arg.js"],
      ),
    ),
  ],
  [
    2363,
    at(
      coercibleOperatorOperand,
      CHECKER(
        "an 'any', wrapper or BigInt operand is plain JavaScript: the operator converts both with ToPrimitive/ToNumeric first",
      ),
    ),
  ],
  [
    2365,
    at(
      coercibleOperatorOperand,
      CHECKER(
        "an 'any', wrapper or BigInt operand is plain JavaScript: the operator converts both with ToPrimitive/ToNumeric first",
        ["tests/corpus/js-primitive-wrappers.js", "tests/corpus/1614-js-fence-dodges.cjs"],
      ),
    ),
  ],
  // `new Iterator()` (TS2511): Iterator is the one abstract class the lib
  // exposes, and Node throws its TypeError at the construction, which the
  // lowering reproduces (iterator-prototype.ts).
  [
    2511,
    THROW(
      "Node throws its TypeError when the abstract Iterator class is constructed, and the lowering reproduces it at the site",
      ["tests/corpus/js-iterator-prototype.js"],
    ),
  ],
  // A base constructor's type-argument count (TS2508): JavaScript writes no
  // type arguments, and `class X extends Iterator` names the lib's generic
  // abstract class. The heritage lowering checks the actual base.
  [
    2508,
    CHECKER(
      "JavaScript writes no type arguments, and the heritage lowering checks the actual base class",
      ["tests/corpus/js-iterator-subclass.js"],
    ),
  ],
  // A symbol operand of `+` or `+=` (TS2469): the operator's ToString throws
  // Node's TypeError, which the lowered conversion raises at the operator
  // (binary.ts and updates.ts lower it to the runtime's string and number
  // conversions). Every other operator keeps the triage's refusal.
  [
    2469,
    at(
      symbolStringOperator,
      THROW(
        "Node throws its TypeError from the ToString the operator performs, and the lowered conversion raises it at the operator",
        ["tests/corpus/9005-symbol-string-concat.js"],
      ),
    ),
  ],
  // A write through a String wrapper's index (TS2542; every other readonly
  // index signature keeps the triage's refusal).
  [
    2542,
    at(
      stringWrapperReceiver,
      CHECKER(
        "Node adds the property past the end and ignores the read-only index writes (sloppy) or throws (strict), as the object does",
        ["tests/corpus/js-primitive-wrappers.js", "tests/corpus/js-primitive-wrappers-zero-arg.js"],
      ),
    ),
  ],
  // The deprecated Buffer(...) call and fs.ReadStream/WriteStream (TS2348;
  // every other class called without `new` keeps the triage's SC1090).
  [
    2348,
    at(
      deprecatedBufferCall,
      CHECKER(
        "Node's Buffer function and the fs stream constructors accept the call without 'new', and the lowering builds them",
        [
          "tests/corpus/7529-buffer-constructor.cjs",
          "tests/corpus/8272-fs-stream-call-without-new.cjs",
        ],
      ),
    ),
  ],
  // 1345, a discarded negation of a void-typed operand (`!register();`):
  // Node evaluates the operand once and throws the boolean away, and the
  // operand's ordinary lowering does exactly that. A consumed negation
  // keeps the triage row below, and a checked project keeps the diagnostic:
  // it asked tsc to judge the test.
  [
    1345,
    inCheckedJs(
      at(
        discardedVoidNegation,
        CHECKER(
          "a discarded negation's boolean is never consumed: Node evaluates the operand once for its effects, and the operand's ordinary lowering does the same",
          ["tests/corpus/discarded-void-negation.mjs"],
        ),
      ),
    ),
  ],
  // ---- The checker's OPINIONS that need no lowering (TS2629 and friends) ----
  // Each row below is a `checker` row: at the admitted site the checker's
  // type is still a truthful bound on every runtime value, so the ordinary
  // lowering already gives Node's answer. A JavaScript source only takes them;
  // a checked project asked tsc for its opinion, so every row here is a
  // `checkedJs: "enforce"` row (D3).
  //
  // 2408, a `return` in a set accessor: the value is discarded by [[Set]],
  // exactly as a `return` in any other call is.
  [
    2408,
    inCheckedJs(
      CHECKER(
        "a setter's `return` value is discarded by [[Set]], as Node discards every setter call's result",
        ["tests/corpus/8944-js-setter-return-values.js"],
      ),
    ),
  ],
  // 17013, `new.target` in a method or accessor body: legal JavaScript, and
  // always undefined because a method is not constructable (the lowering's
  // method-body path answers undefined; every other site keeps the early
  // SyntaxError Node raises).
  [
    17013,
    inCheckedJs(
      at(
        newTargetInMethod,
        CHECKER(
          "`new.target` in a method body is undefined: a method is not constructable, so the meta-property never denotes a constructor there",
          ["tests/corpus/8945-js-new-target-methods.js"],
        ),
      ),
    ),
  ],
  // 4104, assigning a readonly array type to a mutable one: `readonly` is an
  // annotation, and whether the write succeeds depends on the array's frozen
  // state at run time.
  [
    4104,
    inCheckedJs(
      CHECKER(
        "`readonly` is an annotation Node never sees: the assignment and the later write behave as the array's runtime state decides",
        ["tests/corpus/8949-js-readonly-write-targets.js"],
      ),
    ),
  ],
  // 2839, a condition comparing two object references the checker proves
  // distinct (`{} === {}`): the comparison lowering performs Node's
  // reference test, which is the one the checker described.
  [
    2839,
    inCheckedJs(
      CHECKER(
        "two distinct object references never pass a strict-equality test, and the comparison lowering performs that same reference test",
        ["tests/corpus/8951-js-reference-condition-comparisons.js"],
      ),
    ),
  ],
  // 2845, a condition comparing a bigint with a non-finite number or a
  // nullish value (`0n === Infinity`): strict equality compares the types
  // first, and the comparison lowering applies that same test.
  [
    2845,
    inCheckedJs(
      CHECKER(
        "a bigint never equals a non-finite number or a nullish value: the comparison lowering applies Node's type test",
        ["tests/corpus/8952-js-bigint-non-finite-comparisons.js"],
      ),
    ),
  ],
];

/** Every JavaScript checker opinion, by TypeScript code. */
export const JS_OPINIONS: ReadonlyMap<number, Opinion> = new Map(OPINION_ROWS);

/** The opinion admitting `code` in a JavaScript source, or null for a code
 * with none (the triage table's not-yet-admitted states, and codes no
 * journal has observed). */
export function jsOpinion(code: number): Opinion | null {
  return JS_OPINIONS.get(code) ?? null;
}

/* NOT relaxed, though each is legal JavaScript the checker merely dislikes:
 * the construct needs a lowering that does not exist yet, so admitting the
 * code would compile a program the lowerer cannot build correctly.
 *
 *  - TS2365 with no BigInt operand (an operator on operands the lowerer
 *    cannot convert, `true + 1`) needs ToPrimitive on a static operand; the
 *    arithmetic lowering answers SC1043. Its BigInt forms are admitted by the
 *    row above, because the checked-dynamic arithmetic, bitwise and
 *    comparison lowering already applies ToNumeric/ToPrimitive in Node's
 *    order. Its TS2362/2363 siblings (an arithmetic operand of the wrong
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
 *    arguments", `class X extends Iterator {}`) has LEFT this list: the
 *    heritage lowering learned the callable-base path for the lib's generic
 *    abstract Iterator class, and the code is a `checker` row above.
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

/* ── The triage table for the SC0001 tail ──────────────────────────────
 *
 * Every TypeScript code that reaches SC0001 in a JavaScript source and has
 * no JS_OPINIONS row gets one decision here. Admission lives in the opinion
 * table; this table is the NOT-YET-ADMITTED states, plus the fallback for a
 * code whose opinion row has a `site` guard (the sites the guard excludes
 * keep the decision recorded here — TS2348 refuses every class called
 * without `new` except the Buffer and fs-stream constructors, TS2542 every
 * readonly index write except a String wrapper's).
 *
 *   keep     Node rejects the program too (a JavaScript grammar or early
 *            error, or a ReferenceError/TypeError the language guarantees),
 *            so tsc's own text is the honest diagnostic and stays SC0001.
 *   refuse   legal JavaScript scriptc does not lower, and no lowering
 *            change is claimed: SC1090 names the construct.
 *   rewrite  legal JavaScript whose admission needs a lowering change:
 *            SC1090 names the construct today and marks the work.
 *
 * refuse and rewrite both emit a named SC1090 diagnostic at the
 * diagnostic's own location. The table is exhaustive over the codes the
 * Test262 journals observed that no opinion admits everywhere
 * (tsc-codes.test.ts enforces that), so a new code cannot slip through
 * untriaged.
 */

export type JsTscCodeAction = "refuse" | "rewrite" | "keep";

export type JsTscCodeTriage =
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
    1320,
    REWRITE(
      "an 'await' operand the checker cannot prove is a promise",
      "Node awaits any value and ignores a non-callable 'then'; the await lowering needs the hostile-'then' path",
    ),
  ],
  [1329, KEEP(KEEP_GRAMMAR)],
  [1341, KEEP(KEEP_GRAMMAR)],
  // The discarded `!voidCall();` sites are admitted by the 1345 opinion row;
  // every site whose boolean is consumed needs a runtime value for a
  // void-typed operand, which the lowering does not model.
  [
    1345,
    REWRITE(
      "a truthiness test of a void-typed expression whose boolean is used",
      "the checker types the operand 'void', but a callback typed that way can return a value at run time; the test needs a runtime value that the lowering does not model",
    ),
  ],
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
  // The `+` and `+=` forms have left this decision: the JS_OPINIONS row above
  // admits them where the lowering reproduces Node's TypeError. This row
  // stays for the operators whose lowered form would throw another message.
  [
    2469,
    REWRITE(
      "another operator on a symbol operand (`~sym`, `-sym`)",
      "Node throws a TypeError ('Cannot convert a Symbol value to a number') at the operator, and the lowering would raise a differently worded one",
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
  // TS2511 (instantiating an abstract class) has LEFT this table: `new
  // Iterator()` is a JS_OPINIONS `throw` row above, so no JavaScript site
  // reaches this decision any more.
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
      "assigning to a class binding",
      "a class declaration's outer binding is mutable, so Node replaces it; a class declaration's inner binding and a named class expression's inner binding are immutable. Assignments to them throw a TypeError once initialized, or a ReferenceError before initialization. The class lowering does not model these assignments",
    ),
  ],
  [
    2630,
    REWRITE(
      "assigning to a function binding",
      "a function declaration's binding is mutable, so Node replaces it; only a named function expression's inner binding is immutable, where strict code throws a TypeError. The function lowering does not model either assignment",
    ),
  ],
  [2660, KEEP(KEEP_GRAMMAR)],
  [2662, KEEP(KEEP_GRAMMAR)],
  [
    2684,
    REWRITE(
      "a call whose 'this' type the checker rejects",
      "JavaScript passes whatever receiver the expression produces; the this-context lowering is the remaining gap (W6)",
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
      "a value lacking a required property of its declared type",
      "the value is legal JavaScript and Node checks no declared type; the checker names the properties its target type requires. Admitting it needs a differential proof that the lowering is Node-exact — the checker's refusal stands until then",
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
  [2777, KEEP(KEEP_GRAMMAR)],
  [
    2803,
    REWRITE(
      "assigning to a private method",
      "Node throws a TypeError at the assignment; private methods are not writable",
    ),
  ],
  [2815, KEEP(KEEP_GRAMMAR)],
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
  // 17013 has LEFT this table: `new.target` in a method or accessor body is a
  // JS_OPINIONS row above, and every other site keeps the diagnostic
  // unchanged, which is what KEEP did.
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
 * source, or null for a code this table does not cover (a code JS_OPINIONS
 * admits everywhere, and a code no journal has observed). */
export const JS_TSC_CODE_TRIAGE: ReadonlyMap<number, JsTscCodeTriage> = new Map(TRIAGE_ROWS);

export function jsTscCodeTriage(code: number): JsTscCodeTriage | null {
  return JS_TSC_CODE_TRIAGE.get(code) ?? null;
}

/** True for JavaScript source file NAMES (.js/.mjs/.cjs/.jsx) — the files
 * whose types come entirely from inference (checkJs + JSDoc) and whose JS
 * opinion stance (JS_OPINIONS) applies. */
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
