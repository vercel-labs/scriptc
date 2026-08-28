/* Surface tables and provenance predicates of the lowerer: the island
 * surface (Math/number/string/global functions marshalable through the
 * dynamic island), the node builtin-module call tables and their fence
 * hints, the string/array/map/set method-name sets, the unsupported-syntax
 * diagnostic tables, and the "which world declared this symbol" predicates
 * (ambient scriptc.d.ts / standard lib / @types/node provenance). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { UNSUPPORTED } from "../../diagnostics/diagnostic.js";
import { BOOL, BYTES_U8, CHILD_T, DYN, F64, FILEHANDLE_T, IrExpr, IrLibFn, IrStrIntrinsicMethod, IrType, RUNTIME_ERROR_CLASSES, SPAWNRES_T, STATS_T, STRING, URL_T, VOID, arrayOf } from "../../ir/ir.js";
import { isNodeTypesPath, requireSpecOf } from "../program.js";

/** Statement-level constructs rejected wholesale, keyed by syntax kind. */
export const UNSUPPORTED_STMT: Partial<Record<ts.SyntaxKind, { code: keyof typeof UNSUPPORTED; feature?: string }>> = {
  // Top-level ClassDeclarations are supported (collected in run()); one
  // reaching lowerStmt is nested inside a function.
  [ts.SyntaxKind.ClassDeclaration]: { code: "SC1090", feature: "class declarations inside functions" },
  // DoStatement / SwitchStatement are supported; handled in lowerStmt.
  // ForOfStatement is supported (arrays); handled in lowerStmt.
  // ThrowStatement / TryStatement are supported (exceptions); handled in
  // lowerStmt (catch bindings and jumps crossing a finally stay rejected).
  // ForInStatement is supported (records/index-signature shapes via the
  // Object.keys walk, arrays via index strings, globalThis empty) —
  // handled in lowerStmt via lowerForIn; tuple/class/other receivers keep
  // named SC1052 fences there.
  // LabeledStatement is supported (labels on loops/switches directly, a
  // labeled block wrapper for everything else) — handled in lowerStmt via
  // lowerLabeled; what remains fenced is labeled jumps naming a loop whose
  // lowering is a label-free desugar (SC1050 at the jump site).
  // EnumDeclaration is supported (constant members fold; computed members
  // fence) — handled in lowerStmt via lower-enums.ts.
  [ts.SyntaxKind.ModuleDeclaration]: { code: "SC1090", feature: "namespaces" },
  [ts.SyntaxKind.DebuggerStatement]: { code: "SC1090", feature: "debugger statements" },
  // `with` blocks rewrite identifier resolution at runtime — statically
  // uncompilable by design, and already an error in strict-mode JS.
  [ts.SyntaxKind.WithStatement]: {
    code: "SC1090",
    feature: "'with' statements (runtime scope injection has no static resolution — bind the object to a variable and read members through it)",
  },
};

export const UNSUPPORTED_EXPR: Partial<Record<ts.SyntaxKind, { code: keyof typeof UNSUPPORTED; feature?: string }>> = {
  // ArrowFunction / FunctionExpression are supported (closures); handled in
  // lowerExpr before this table.
  [ts.SyntaxKind.ClassExpression]: { code: "SC1020" },
  // ObjectLiteralExpression is supported (records); handled in lowerExpr.
  // ArrayLiteralExpression / ElementAccessExpression are supported (arrays);
  // handled in lowerExpr.
  // PropertyAccessExpression rejections are per-site in lowerExpr (the
  // receiver lowers first — its blocker wins — and the residue names the
  // property and receiver type; never a generic "property access").
  // NewExpression / ThisKeyword are supported (classes); handled in lowerExpr.
  // YieldExpression is supported (generators); handled in lowerExpr via
  // lowerYield (value-position yield* and non-generator contexts keep
  // their SC1071 fences there).
  // TaggedTemplateExpression is supported (an interned per-site strings
  // object + an ordinary call); handled in lowerExpr via lowerTaggedTemplate.
  [ts.SyntaxKind.TypeOfExpression]: { code: "SC1090", feature: "typeof expressions" },
  [ts.SyntaxKind.DeleteExpression]: { code: "SC1090", feature: "delete expressions" },
  // RegularExpressionLiteral is supported (regex); handled in lowerExpr.
  [ts.SyntaxKind.SpreadElement]: { code: "SC1090", feature: "spread arguments" },
  // PostfixUnaryExpression is supported (expression-position ++/-- over
  // f64 locals/globals — lowerIncDec); field/element receivers fence there.
};

/** The narrow-first hint every union fence shares — how to get from a
 * union-typed value to the single arm the static compiler can use. One
 * string so the fences speak with one voice (and match SC2003's hint). */
export const NARROW_FIRST =
  "narrow first: check a discriminant field, or compare with '!== undefined'/'!== null' for unit arms";

/* ── the options-record stance ───────────────────────────────────────────
 * Node's object-options rule: an options record's unknown keys are simply
 * IGNORED — the runtime reads the keys it documents and never validates
 * the rest, so `http.request({ port, wibble: 1 })` runs identically to the
 * wibble-free call. Rejecting a real Node program's option keys with a
 * generic excess-property error is therefore itself a divergence, so the
 * RECORD-shaped options parameters of the fallback surface carry an
 * `[option: string]: unknown` index signature (every key typechecks) and
 * each option WALK splits per key instead:
 *   - lowered keys take their lowering (bad VALUE shapes keep their
 *     per-key fences);
 *   - keys Node DOCUMENTS for the API but this compiler cannot honor
 *     fence BY NAME at the use site — an option that changes
 *     Node-observable behavior must work or fence, never silently drop;
 *   - undocumented keys DROP exactly as Node drops them, provided the
 *     value expression is side-effect-free (an effectful initializer
 *     fences: Node would have evaluated it, so skipping it would be
 *     observable). A bare `__proto__: value` assignment with an
 *     object-capable value is not droppable: it may change the record's
 *     prototype, and Node may read documented options inherited from it.
 * fenceOrDropOptionKey is that split's tail — option walks call it for
 * every key outside their lowered set. */

/** True iff evaluating the option value can have no observable effect —
 * the drop-safety test of the options-record stance. Literals, identifier
 * reads (shorthand included), closures (created, never called — the key
 * is unknown, so nothing can reach it), prefix +/-/! over these, and
 * object/array literals of these all qualify; anything with a call,
 * a property read (getters), or an assignment does not. */
export function sideEffectFreeOptionValue(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertion(e)) e = e.expression;
  if (ts.isIdentifier(e)) return true; // includes `undefined`
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isBigIntLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword ||
      e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isPrefixUnaryExpression(e) &&
      (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken ||
       e.operator === ts.SyntaxKind.ExclamationToken)) {
    return sideEffectFreeOptionValue(e.operand);
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) =>
      ts.isShorthandPropertyAssignment(p) ||
      (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) &&
        sideEffectFreeOptionValue(p.initializer)));
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => !ts.isSpreadElement(el) && sideEffectFreeOptionValue(el));
  }
  return false;
}

/** True when an object-literal `__proto__: value` entry is provably a
 * no-op. The special prototype setter accepts only objects or null; every
 * primitive value is ignored. Unknown/object-capable types stay fenced. */
function primitiveProtoValueIsIgnored(lowerer: Lowerer, node: ts.Expression): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  const t = lowerer.typeOf(node);
  const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
  return parts.every((p) => (p.flags & primitive) !== 0);
}

/** The stance's tail: `key` is outside the walk's lowered set. Documented
 * keys of the API fence by name (pointed per-key hints first, the walk's
 * supported-options hint otherwise); undocumented keys drop like Node
 * drops them when the value is side-effect-free, and fence when it is
 * not. `prop` is the property entry (assignment or shorthand) for spans. */
export function fenceOrDropOptionKey(
  lowerer: Lowerer,
  prop: ts.ObjectLiteralElementLike,
  key: string,
  api: string,
  documented: ReadonlySet<string>,
  supportedHint: string,
  pointedHints?: Record<string, string | undefined>,
): void {
  if (documented.has(key)) {
    lowerer.noLowering(`${api} option '${key}'`, prop, pointedHints?.[key] ?? supportedHint);
  }
  if (
    key === "__proto__" &&
    ts.isPropertyAssignment(prop) &&
    !ts.isComputedPropertyName(prop.name) &&
    !primitiveProtoValueIsIgnored(lowerer, prop.initializer)
  ) {
    lowerer.noLowering(
      `${api} option '__proto__'`,
      prop,
      "a bare __proto__: value entry changes the options object's prototype, so inherited options cannot be lowered",
    );
  }
  const value = ts.isPropertyAssignment(prop) ? prop.initializer : null;
  if (value !== null && !sideEffectFreeOptionValue(value)) {
    lowerer.noLowering(
      `the undocumented ${api} option '${key}' with an effectful value`,
      prop,
      "Node ignores undocumented option keys and so does this compiler, but Node still evaluates the value — hoist it (const v = ...) or drop the entry",
    );
  }
  // Dropped: Node's own ignore, byte-exact.
}

/** http.request/http.get's documented option keys (Node v24 — the
 * `http.request(options)` and `net.socket.connect` tables); everything
 * else on a client options literal is undocumented and drops. */
export const HTTP_CLIENT_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "agent", "auth", "createConnection", "defaultPort", "family", "headers",
  "hints", "host", "hostname", "insecureHTTPParser", "joinDuplicateHeaders",
  "localAddress", "localPort", "lookup", "maxHeaderSize", "method", "path",
  "port", "protocol", "setDefaultHeaders", "setHost", "signal", "socketPath",
  "timeout", "uniqueHeaders",
]);

/** http.createServer / http.Server's documented option keys (Node v24 —
 * http.createServer options + the net.Server knobs it forwards). The
 * lowered set is requireHostHeader/joinDuplicateHeaders plus
 * keepAliveTimeoutBuffer storage; the rest fence by name here, and
 * unknown keys drop like Node drops them. */
export const HTTP_SERVER_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "IncomingMessage", "ServerResponse", "allowHalfOpen", "connectionsCheckingInterval",
  "headersTimeout", "highWaterMark", "insecureHTTPParser", "joinDuplicateHeaders",
  "keepAlive", "keepAliveInitialDelay", "keepAliveTimeout", "keepAliveTimeoutBuffer", "maxHeaderSize",
  "noDelay", "pauseOnConnect", "rejectNonStandardBodyWrites", "requestTimeout",
  "requireHostHeader", "uniqueHeaders",
]);

/** new http.Agent(options)'s documented keys (Node v24 — the Agent
 * constructor table plus the socket.connect() options it forwards into
 * each dial). The lowered set is keepAlive/keepAliveMsecs/maxSockets/
 * maxFreeSockets/timeout/port (+ scheduling, dropped: no free pool
 * exists); the rest fence by name and unknown keys drop like Node. */
export const AGENT_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "family", "hints", "host", "keepAliveInitialDelay", "localAddress",
  "localPort", "lookup", "maxTotalSockets", "noDelay", "path",
]);

/** https.request adds tls.connect's client-side TLS knobs. */
export const HTTPS_CLIENT_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  ...HTTP_CLIENT_DOCUMENTED_OPTIONS,
  "ca", "cert", "checkServerIdentity", "ciphers", "clientCertEngine", "crl",
  "dhparam", "ecdhCurve", "highWaterMark", "honorCipherOrder", "key",
  "maxVersion", "minVersion", "passphrase", "pfx", "privateKeyEngine",
  "privateKeyIdentifier", "rejectUnauthorized", "secureOptions",
  "secureProtocol", "servername", "session", "sessionIdContext",
  "sessionTimeout", "sigalgs", "ticketKeys",
]);

/** tls.createServer / tls.createSecureContext / https.createServer /
 * http2.createSecureServer's documented TLS-side option keys (Node v24 —
 * tls.createSecureContext + tls.createServer + net.createServer). */
export const TLS_SERVER_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "ALPNProtocols", "ALPNCallback", "SNICallback", "allowHalfOpen", "ca",
  "cert", "ciphers", "clientCertEngine", "crl", "dhparam", "ecdhCurve",
  "enableTrace", "handshakeTimeout", "highWaterMark", "honorCipherOrder",
  "keepAlive", "keepAliveInitialDelay", "key", "maxVersion", "minVersion",
  "noDelay", "passphrase", "pauseOnConnect", "pfx", "privateKeyEngine",
  "privateKeyIdentifier", "pskCallback", "pskIdentityHint",
  "rejectUnauthorized", "requestCert", "requestOCSP", "secureContext",
  "secureOptions", "secureProtocol", "sessionIdContext", "sessionTimeout",
  "sigalgs", "ticketKeys",
]);

/** http2.createSecureServer's documented keys: the h2 knobs on top of the
 * TLS server set. */
export const HTTP2_SECURE_SERVER_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  ...TLS_SERVER_DOCUMENTED_OPTIONS,
  "allowHTTP1", "maxDeflateDynamicTableSize", "maxSettings",
  "maxSessionMemory", "maxHeaderListPairs", "maxOutstandingPings",
  "maxSendHeaderBlockLength", "origins", "paddingStrategy",
  "peerMaxConcurrentStreams", "remoteCustomSettings", "selectPadding",
  "settings", "streamResetBurst", "streamResetRate",
  "unknownProtocolTimeout",
]);

/** fs.watch's documented option keys. */
export const FS_WATCH_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "persistent", "recursive", "encoding", "signal",
]);

/** fs.readdirSync's documented option keys. */
export const FS_READDIR_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "encoding", "withFileTypes", "recursive",
]);

/** fs.writeFileSync's documented option keys. */
export const FS_WRITE_FILE_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "encoding", "mode", "flag", "flush", "signal",
]);

/** dns.lookup's documented option keys. */
export const DNS_LOOKUP_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "family", "hints", "all", "order", "verbatim",
]);

/** querystring.parse's documented option keys (Node v24). */
export const QS_PARSE_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "maxKeys", "decodeURIComponent",
]);

/** querystring.stringify's documented option keys (Node v24). */
export const QS_STRINGIFY_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "encodeURIComponent",
]);

/** readline.createInterface's documented option keys. */
export const READLINE_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set([
  "input", "output", "completer", "terminal", "history", "historySize",
  "removeHistoryDuplicates", "prompt", "crlfDelay", "escapeCodeTimeout",
  "tabSize", "signal",
]);

/** The lowered Array<T> method surface. Like STR_METHODS, membership is
 * only half the check — the resolved symbol must be declared by the
 * standard library (isStdlibMember); lib-declared array methods outside
 * this set hit the SC2020 fence. */
export const ARRAY_METHODS = new Set([
  "push",
  "unshift",
  "pop",
  "reverse",
  "concat",
  "map",
  "filter",
  "forEach",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "at",
  "flatMap",
  "reduce",
  "reduceRight",
  "indexOf",
  "includes",
  "join",
  "slice",
  "toReversed",
  "toSpliced",
  "toSorted",
  "with",
]);

/** The lowered Map<K, V> method surface. Like ARRAY_METHODS, membership is
 * only half the check — the resolved symbol must be declared by the
 * standard library (isStdlibMember). `size` is a property, handled in
 * property-access position. */
export const MAP_METHODS = new Set(["get", "set", "has", "delete", "clear", "forEach"]);

/** The lowered Set<T> method surface — Map's minus get/set plus add.
 * `size` is a property, handled in property-access position. */
export const SET_METHODS = new Set(["add", "has", "delete", "clear", "forEach"]);

/** The ES2025 Set composition surface (union/intersection/…): desugared
 * to interned helper loops over the set iteration primitives — no user
 * code runs mid-loop, so the walks need no enter/exit bracketing. The
 * lib accepts any ReadonlySetLike argument; only a real Set lowers (the
 * argument's has/size must be the builtins for the desugar to BE the
 * spec's algorithm). */
export const SET_COMBINE_METHODS = new Set([
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
]);

export type CompoundOp = "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>";

export const COMPOUND_ASSIGN_OPS: Partial<Record<ts.SyntaxKind, CompoundOp>> = {
  [ts.SyntaxKind.PlusEqualsToken]: "+",
  [ts.SyntaxKind.MinusEqualsToken]: "-",
  [ts.SyntaxKind.AsteriskEqualsToken]: "*",
  [ts.SyntaxKind.SlashEqualsToken]: "/",
  [ts.SyntaxKind.AmpersandEqualsToken]: "&",
  [ts.SyntaxKind.BarEqualsToken]: "|",
  [ts.SyntaxKind.CaretEqualsToken]: "^",
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: "<<",
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ">>",
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ">>>",
  [ts.SyntaxKind.PercentEqualsToken]: "%",
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: "**",
};

/** String methods lowered to `strIntrinsic` (`.length` is handled in
 * property-access position). Membership here is only half the check: the
 * resolved symbol must also be declared by the standard library (see
 * isStdlibMember), so a user-declared `slice` on some other type can never
 * smuggle itself in by name. `minArgs`/`maxArgs` pin the LOWERED call
 * forms: the lib declares wider signatures (optional position/fromIndex
 * parameters) that typecheck but have no lowering — those forms are fenced
 * per site instead of silently dropping arguments. */
export const STR_METHODS: Record<
  string,
  { method: IrStrIntrinsicMethod; result: IrType; minArgs: number; maxArgs: number }
> = {
  charCodeAt: { method: "charCodeAt", result: F64, minArgs: 1, maxArgs: 1 },
  charAt: { method: "charAt", result: STRING, minArgs: 1, maxArgs: 1 },
  indexOf: { method: "indexOf", result: F64, minArgs: 1, maxArgs: 2 },
  // includes with a position argument is indexOf's clamp exactly (the
  // spec routes both through StringIndexOf) — the emitter composes
  // scr_str_index_of(...) != -1 for the two-argument form.
  includes: { method: "includes", result: BOOL, minArgs: 1, maxArgs: 2 },
  startsWith: { method: "startsWith", result: BOOL, minArgs: 1, maxArgs: 1 },
  endsWith: { method: "endsWith", result: BOOL, minArgs: 1, maxArgs: 1 },
  slice: { method: "slice", result: STRING, minArgs: 0, maxArgs: 2 },
  // substring: slice's clamp-and-swap sibling (negatives clamp to 0
  // instead of counting from the end; start > end swaps).
  substring: { method: "substring", result: STRING, minArgs: 1, maxArgs: 2 },
  repeat: { method: "repeat", result: STRING, minArgs: 1, maxArgs: 1 },
  trim: { method: "trim", result: STRING, minArgs: 0, maxArgs: 0 },
  trimStart: { method: "trimStart", result: STRING, minArgs: 0, maxArgs: 0 },
  trimEnd: { method: "trimEnd", result: STRING, minArgs: 0, maxArgs: 0 },
  // The Annex B aliases (lib.es2019 declares them as trimStart/trimEnd's
  // deprecated twins — same behavior, per spec).
  trimLeft: { method: "trimStart", result: STRING, minArgs: 0, maxArgs: 0 },
  trimRight: { method: "trimEnd", result: STRING, minArgs: 0, maxArgs: 0 },
  // The STRING-separator split (regex separators lower earlier as a
  // regexIntrinsic). The optional limit is completed to 2^32-1 by the
  // lowering so the IR/runtime always see the spec's effective value.
  // Empty separator splits per UTF-16 code unit —
  // astral halves become U+FFFD (SEMANTICS.md divergence 2, the same
  // substitution the island's boundary marshal applied).
  split: { method: "split", result: arrayOf(STRING), minArgs: 1, maxArgs: 2 },
  // padStart/padEnd with the fill omitted: Node pads with " " — the
  // lowering completes the default (lowerStringMethodCall).
  padStart: { method: "padStart", result: STRING, minArgs: 1, maxArgs: 2 },
  padEnd: { method: "padEnd", result: STRING, minArgs: 1, maxArgs: 2 },
  // The lre-backed pair (ECMA Default Case Conversion, final sigma
  // included — scr_regex.c): static now, no island needed; their presence
  // flips the regex LINK switch (moduleUsesRegex).
  toLowerCase: { method: "toLowerCase", result: STRING, minArgs: 0, maxArgs: 0 },
  toUpperCase: { method: "toUpperCase", result: STRING, minArgs: 0, maxArgs: 0 },
  // The ES2024 well-formedness pair — no-ops over the runtime's
  // well-formed storage (constant true / the identity, per spec on
  // well-formed input; where Node would answer false the program already
  // diverged at the string's creation, SEMANTICS.md 2).
  isWellFormed: { method: "isWellFormed", result: BOOL, minArgs: 0, maxArgs: 0 },
  toWellFormed: { method: "toWellFormed", result: STRING, minArgs: 0, maxArgs: 0 },
};

/** One member of the island-backed ambient surface: declared argument
 * types (tsc enforces them at call sites; the arity double-checks the
 * table against the ambient file) and the validated island-exit target the
 * engine's result must satisfy. */
export interface IslandFnEntry {
  args: IrType[];
  ret: IrType;
}

const ISL_N1: IslandFnEntry = { args: [F64], ret: F64 };

const ISL_N2: IslandFnEntry = { args: [F64, F64], ret: F64 };

export const boundaryIntoIslandMsg = (typeName: string): string =>
  `passing a value of type '${typeName}' into dynamically-executed ('any'-typed) code ` +
  `(only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, ` +
  `and JSON-safe records/arrays/unions can cross the boundary)`;

export const boundaryOutOfIslandMsg = (typeName: string): string =>
  `using an 'any' value where '${typeName}' is expected ` +
  `(an 'any' value can only exit to numbers, strings, booleans, JSON-safe records/arrays/unions, ` +
  `and 'T | undefined' over those)`;

/** The island-backed surface — standard-library APIs with no static
 * runtime implementation (Math.*, number/string methods beyond the
 * intrinsic set, parseFloat, ...). ONE table drives both sides of the
 * gate: under --dynamic each entry lowers to marshal → engine execution →
 * validated exit to the declared return type; without the flag each use
 * site is a per-site SC2012. Membership here is only half the check — the
 * resolved symbol must be declared by the standard library (provenance,
 * never names), so a user's own `parseFloat` or `.toFixed` takes the
 * ordinary paths. The lib declares MORE than this table (extra members,
 * optional-parameter forms): everything untabled falls through to the
 * SC2020 lib fence — never an ICE, never a link error. Exported so the
 * table-vs-lib consistency test can check every entry against the lib's
 * own declarations — a drifted entry fails a test instead of surprising a
 * user. */
export const ISLAND_SURFACE = {
  /** `Math.<fn>(...)` lowers to callMethod(globalGet("Math"), fn, args).
   * min/max/atan2/hypot/pow are declared with exactly two parameters
   * (rest/optional parameters aren't representable). */
  math: {
    // floor, min/max (two-arg), and random are STATIC now
    // (STATIC_MATH_FNS below).
    fns: {
      abs: ISL_N1, acos: ISL_N1, asin: ISL_N1, atan: ISL_N1, atan2: ISL_N2,
      cbrt: ISL_N1, ceil: ISL_N1, cos: ISL_N1, exp: ISL_N1,
      hypot: ISL_N2, log: ISL_N1, log2: ISL_N1, log10: ISL_N1, pow: ISL_N2,
      round: ISL_N1,
      sign: ISL_N1, sin: ISL_N1, sqrt: ISL_N1, tan: ISL_N1, trunc: ISL_N1,
    } as Record<string, IslandFnEntry | undefined>,
    props: {} as Record<string, IrType | undefined>,
  },
  /** Methods on `number` receivers. The receiver marshals by value; the
   * engine auto-boxes primitives on method calls, so `this` binds the
   * number exactly as in JS. toString takes an EXPLICIT radix (radix-free
   * conversion is the static template-literal path). */
  number: {
    toFixed: { args: [F64], ret: STRING },
    toPrecision: { args: [F64], ret: STRING },
    toString: { args: [F64], ret: STRING },
  } as Record<string, IslandFnEntry | undefined>,
  /** Methods on `string` receivers beyond the static strIntrinsic set
   * (split/pad/trimStart/trimEnd moved to STR_METHODS — static now).
   * replace/replaceAll take STRING patterns (no regex is declared). `at`
   * returns `string`: out of range, the engine yields undefined and the
   * validated exit refuses it with a catchable TypeError (the documented
   * divergence from `string | undefined`). */
  string: {
    replace: { args: [STRING, STRING], ret: STRING },
    replaceAll: { args: [STRING, STRING], ret: STRING },
    at: { args: [F64], ret: STRING },
  } as Record<string, IslandFnEntry | undefined>,
  /** Global functions: parseInt and isNaN are STATIC (lower-calls.ts →
   * num.parseInt/num.isNaN), and parseFloat/isFinite lower statically
   * over EXACTLY-typed arguments (a string for parseFloat, a number for
   * isFinite — num.parseFloat/number.isFinite); these island entries
   * carry every OTHER argument shape, where the ToNumber/ToString
   * coercions stay engine territory. */
  globals: {
    parseFloat: { args: [STRING], ret: F64 },
    isFinite: { args: [F64], ret: BOOL },
  } as Record<string, IslandFnEntry | undefined>,
};

export const STATIC_MATH_PROPS: Record<string, number | undefined> = {
  E: Math.E,
  PI: Math.PI,
};

/** Math members with a STATIC lowering — each is one C call that IS the
 * JS operation, at the tabled arity (floor: libm's floor; min/max: the
 * NaN-poisoning ±0-ordered scalar folds; random: arc4random-backed
 * uniform [0,1) — SEMANTICS.md 62). Checked BEFORE the island table
 * (lowerIslandMethodCall), so the tabled arities compile statically and
 * other arities keep the island/fence story — except min/max, whose
 * variadic spelling lowers at ANY plain arity (the n-ary left fold of
 * the scalar compare; zero arguments answer the fold's ∓Infinity seed);
 * unioned with the island table for the methods-as-values fence
 * (lowerMathProperty). */
export const STATIC_MATH_FNS: Record<string, { fn: IrLibFn; arity: number } | undefined> = {
  floor: { fn: "math.floor", arity: 1 },
  abs: { fn: "math.abs", arity: 1 },
  round: { fn: "math.round", arity: 1 },
  // trunc/ceil joined the static table with ask 4: they are the
  // integer-boundary inference's wholeness-discharge operators (C
  // trunc()/ceil() ARE the JS operations, like floor).
  trunc: { fn: "math.trunc", arity: 1 },
  ceil: { fn: "math.ceil", arity: 1 },
  min: { fn: "math.min", arity: 2 },
  max: { fn: "math.max", arity: 2 },
  random: { fn: "math.random", arity: 0 },
};

/** Number prototype methods with dedicated STATIC lowering paths. The
 * libCall spellings are also the compiled-graph witnesses used by library
 * fences, while the arity range is the surface manifest's support claim. */
export const STATIC_NUMBER_METHODS: Record<
  string,
  { fns: readonly IrLibFn[]; minArgs: number; maxArgs: number } | undefined
> = {
  toFixed: { fns: ["num.toFixed0", "num.toFixed"], minArgs: 0, maxArgs: 1 },
};

/** One lowerable builtin-module FUNCTION: `fn`'s libCall with `params`
 * completed exactly. `variadicPack` marks Node's rest-parameter functions
 * (path.join/resolve): every argument lowers as a string and the frontend
 * packs them into ONE string[] array-literal argument, so the C ABI stays
 * fixed-arity. `defaults` completes omitted TRAILING arguments with string
 * literals (path.basename's suffix → "", a Node no-op). */
export interface BuiltinModuleFn {
  fn: IrLibFn;
  params: IrType[];
  result: IrType;
  variadicPack?: boolean;
  defaults?: string[];
}

/** The lowerable surface of the supported node builtin modules, keyed by
 * CANONICAL module name (both "fs" and "node:fs" land on "fs" — see
 * canonicalBuiltinModule). Like STR_METHODS, membership is only half the
 * check — the identifier must be an IMPORT BINDING from that module's
 * specifier (see builtinImportOf), so a user function named `readFileSync`
 * can never smuggle itself in. Members @types/node declares beyond these
 * tables typecheck and hit the SC2020-family fence at their use site. */
/** node:path's POSIX members — the bare-module table on posix targets and
 * "path/posix" everywhere (Node's own aliasing: bare `path` IS the
 * target platform's implementation, and each named namespace answers ITS
 * platform's rules on any host). toNamespacedPath is the posix identity
 * (Node: a non-op on posix systems). */
const PATH_MODULE_FNS: Record<string, BuiltinModuleFn | undefined> = {
  join: { fn: "path.join", params: [STRING], result: STRING, variadicPack: true },
  resolve: { fn: "path.resolve", params: [STRING], result: STRING, variadicPack: true },
  normalize: { fn: "path.normalize", params: [STRING], result: STRING },
  dirname: { fn: "path.dirname", params: [STRING], result: STRING },
  basename: { fn: "path.basename", params: [STRING, STRING], result: STRING, defaults: [""] },
  extname: { fn: "path.extname", params: [STRING], result: STRING },
  isAbsolute: { fn: "path.isAbsolute", params: [STRING], result: BOOL },
  relative: { fn: "path.relative", params: [STRING, STRING], result: STRING },
  toNamespacedPath: { fn: "path.toNamespacedPath", params: [STRING], result: STRING },
};

/** The win32 twins (scr_path.c's Node-v24 path.win32 port, byte-for-byte):
 * "path/win32" everywhere, and the bare-module table when the build
 * TARGETS win32 — Node on Windows is path.win32. */
const PATH_WIN32_MODULE_FNS: Record<string, BuiltinModuleFn | undefined> = {
  join: { fn: "path.win32Join", params: [STRING], result: STRING, variadicPack: true },
  resolve: { fn: "path.win32Resolve", params: [STRING], result: STRING, variadicPack: true },
  normalize: { fn: "path.win32Normalize", params: [STRING], result: STRING },
  dirname: { fn: "path.win32Dirname", params: [STRING], result: STRING },
  basename: { fn: "path.win32Basename", params: [STRING, STRING], result: STRING, defaults: [""] },
  extname: { fn: "path.win32Extname", params: [STRING], result: STRING },
  isAbsolute: { fn: "path.win32IsAbsolute", params: [STRING], result: BOOL },
  relative: { fn: "path.win32Relative", params: [STRING, STRING], result: STRING },
  toNamespacedPath: { fn: "path.win32ToNamespacedPath", params: [STRING], result: STRING },
};

export const BUILTIN_MODULE_FNS: Record<string, Record<string, BuiltinModuleFn | undefined> | undefined> = {
  fs: {
    readFileSync: { fn: "fs.readFileSync", params: [STRING, STRING], result: STRING },
    writeFileSync: { fn: "fs.writeFileSync", params: [STRING, STRING], result: VOID },
    appendFileSync: { fn: "fs.appendFileSync", params: [STRING, STRING], result: VOID },
    existsSync: { fn: "fs.existsSync", params: [STRING], result: BOOL },
    mkdirSync: { fn: "fs.mkdirSync", params: [STRING], result: VOID },
    rmSync: { fn: "fs.rmSync", params: [STRING], result: VOID },
    rmdirSync: { fn: "fs.rmdirSync", params: [STRING], result: VOID },
    readdirSync: { fn: "fs.readdirSync", params: [STRING], result: arrayOf(STRING) },
    statSync: { fn: "fs.statSync", params: [STRING], result: STATS_T },
    mkdtempSync: { fn: "fs.mkdtempSync", params: [STRING], result: STRING },
    // accessSync's omitted mode completes to 0 (F_OK) in the special case
    // in lowerBuiltinModuleCall — string `defaults` can't spell a number.
    accessSync: { fn: "fs.accessSync", params: [STRING, F64], result: VOID },
    unlinkSync: { fn: "fs.unlinkSync", params: [STRING], result: VOID },
    chmodSync: { fn: "fs.chmodSync", params: [STRING, F64], result: VOID },
    chownSync: { fn: "fs.chownSync", params: [STRING, F64, F64], result: VOID },
    // The 2-argument form only: Node's mode flags (COPYFILE_EXCL, ...)
    // land on the arity fence.
    copyFileSync: { fn: "fs.copyFileSync", params: [STRING, STRING], result: VOID },
    // The callback form is special-cased in lowerBuiltinModuleCall: its
    // Error | null parameter is program-shaped and needs an emitted
    // adapter. The row still projects the static surface and routes the
    // dispatch.
    rename: { fn: "fs.renameCb", params: [], result: VOID },
    renameSync: { fn: "fs.renameSync", params: [STRING, STRING], result: VOID },
    // statSync's no-follow sibling; stats.isSymbolicLink answers what the
    // follow-free snapshot saw.
    lstatSync: { fn: "fs.lstatSync", params: [STRING], result: STATS_T },
    // realpath(3) — Node's realpathSync (failures spell syscall "lstat",
    // Node's own message shape).
    realpathSync: { fn: "fs.realpathSync", params: [STRING], result: STRING },
    // The fd pair behind spawn's fd-stdio form (the daemon-log idiom:
    // openSync(logPath, "a") → spawn stdio ["ignore", fd, fd] →
    // closeSync). openSync takes Node's string flags ("r", "w", "a", the
    // +/x variants — unknown flags throw Node's TypeError text); the
    // numeric-mode third argument fences by arity.
    openSync: { fn: "fs.openSync", params: [STRING, STRING], result: F64 },
    // The buffer forms (fd, buffer, offset, length[, position]). The
    // lowering completes an omitted or literal-null position to -1 (the
    // runtime's current-offset sentinel); numeric positions read without
    // advancing the fd. The options-object and bigint forms still fence.
    readSync: { fn: "fs.readSync", params: [F64, BYTES_U8, F64, F64, F64], result: F64 },
    // Entirely special-cased: the classic Buffer window and utf8 string
    // overloads lower to separate fixed-width runtime ABIs. As with
    // readSync, -1 is the current-offset sentinel.
    writeSync: { fn: "fs.writeSync", params: [F64, BYTES_U8, F64, F64, F64], result: F64 },
    closeSync: { fn: "fs.closeSync", params: [F64], result: VOID },
    // Entirely special-cased (lowerFsWatchCall — the callback needs an
    // adapter per listener shape); this entry only routes the dispatch.
    watch: { fn: "fs.watch", params: [], result: VOID },
  },
  "fs/promises": {
    // The sync operations behind already-settled promises: failures
    // REJECT (catchable at the await) instead of throwing. readFile is
    // utf8-fenced exactly like readFileSync (same special case below).
    readFile: { fn: "fsp.readFile", params: [STRING, STRING], result: { kind: "promise", inner: STRING } },
    writeFile: { fn: "fsp.writeFile", params: [STRING, STRING], result: { kind: "promise", inner: VOID } },
    mkdir: { fn: "fsp.mkdir", params: [STRING], result: { kind: "promise", inner: VOID } },
    readdir: { fn: "fsp.readdir", params: [STRING], result: { kind: "promise", inner: arrayOf(STRING) } },
    rm: { fn: "fsp.rm", params: [STRING], result: { kind: "promise", inner: VOID } },
    stat: { fn: "fsp.stat", params: [STRING], result: { kind: "promise", inner: STATS_T } },
    unlink: { fn: "fsp.unlink", params: [STRING], result: { kind: "promise", inner: VOID } },
    chmod: { fn: "fsp.chmod", params: [STRING, F64], result: { kind: "promise", inner: VOID } },
    rename: { fn: "fsp.rename", params: [STRING, STRING], result: { kind: "promise", inner: VOID } },
    // open's optional flags/mode completion is special-cased in
    // lowerBuiltinModuleCall; this row routes all import spellings and
    // gives coverage the static member.
    open: { fn: "fsp.open", params: [STRING, STRING, F64], result: { kind: "promise", inner: FILEHANDLE_T } },
  },
  // The bare module's POSIX-target binding; a win32 target rebinds it to
  // the win32 table (builtinModuleFnsOf — Node on Windows IS path.win32).
  path: PATH_MODULE_FNS,
  // Real Node modules ("node:path/posix" resolves), and the receivers of
  // `path.posix.<member>` / `path.win32.<member>` through the namespace
  // chain (builtinNamespaceModuleOf composes "path" + ".posix" to these
  // keys). Both namespaces carry the FULL surface on every platform,
  // Node's own rule: each answers its own platform's semantics anywhere.
  "path/posix": PATH_MODULE_FNS,
  "path/win32": PATH_WIN32_MODULE_FNS,
  os: {
    // One platform implementation: os.platform() === process.platform.
    platform: { fn: "process.platform", params: [], result: STRING },
    homedir: { fn: "os.homedir", params: [], result: STRING },
    tmpdir: { fn: "os.tmpdir", params: [], result: STRING },
    // uname(2)'s release field — Node's own implementation.
    release: { fn: "os.release", params: [], result: STRING },
    // uname(2)'s sysname field ("Darwin", "Linux", "Windows_NT") — the
    // libFn/runtime pair predates this entry (the portless surface used
    // them); this row makes the MODULE call reach them (test/common's
    // isAIX/isIBMi getters are the canonical callers).
    type: { fn: "os.type", params: [], result: STRING },
    // Total physical memory in bytes — same predating-pair story.
    totalmem: { fn: "os.totalmem", params: [], result: F64 },
    // Entirely special-cased (lowerOsNetworkInterfacesCall): the result is
    // the call site's mapped Dict<NetworkInterfaceInfo[]> shape, verified
    // structurally there — this entry only routes the dispatch.
    networkInterfaces: { fn: "os.networkInterfaces", params: [], result: VOID },
    // Special-cased too (lowerOsUserInfoCall): the call site's mapped
    // UserInfo record assembles field-by-field from scalar libCalls.
    userInfo: { fn: "os.userName", params: [], result: VOID },
  },
  crypto: {
    randomUUID: { fn: "crypto.randomUUID", params: [], result: STRING },
    // A real Buffer result. The composed randomBytes(n).toString(enc)
    // form KEEPS its one-libCall lowering (lowerCryptoComposedCall runs
    // first and the Buffer never materializes there); this entry covers
    // the bare calls and non-composed uses.
    randomBytes: { fn: "crypto.randomBytes", params: [F64], result: BYTES_U8 },
  },
  zlib: {
    // Buffer in, Buffer out, Node's default options; string inputs fence
    // per site (see the zlib special case in lowerBuiltinModuleCall).
    // native-toolchain.ts links libz only when these appear on the IR.
    deflateSync: { fn: "zlib.deflateSync", params: [BYTES_U8], result: BYTES_U8 },
    inflateSync: { fn: "zlib.inflateSync", params: [BYTES_U8], result: BYTES_U8 },
  },
  url: {
    // fileURLToPath accepts a URL value OR a string — the call lowering
    // picks the libFn by the ARGUMENT's static type (see the special case
    // in lowerBuiltinModuleCall); the table entry carries the string form.
    fileURLToPath: { fn: "url.fileURLToPathStr", params: [STRING], result: STRING },
    pathToFileURL: { fn: "url.pathToFileURL", params: [STRING], result: URL_T },
  },
  child_process: {
    // spawnSync's and spawn's call completions are entirely special-cased
    // (an omitted args list completes to an empty string[]; spawnSync
    // accepts exactly { encoding: "utf8" } as options, spawn requires
    // exactly { stdio: "ignore" } — see lowerBuiltinModuleCall); the
    // entries carry the canonical shapes.
    spawnSync: { fn: "cp.spawnSync", params: [STRING, arrayOf(STRING)], result: SPAWNRES_T },
    spawn: { fn: "cp.spawn", params: [STRING, arrayOf(STRING)], result: CHILD_T },
    // execFileSync(file, args?, options?) and execSync(command, options?)
    // share the cp.execSync runtime entry (execSync sets the shell flag);
    // both call completions are special-cased in lowerBuiltinModuleCall.
    // The entries carry canonical shapes for the coverage/fence machinery.
    execFileSync: { fn: "cp.execSync", params: [STRING, arrayOf(STRING)], result: STRING },
    execSync: { fn: "cp.execSync", params: [STRING], result: STRING },
  },
  // node:util lowers through dedicated paths: promisify
  // only in the const-binding-over-execFile shape — recognized in
  // lowerVarDecl / collectGlobals BEFORE any call lowering runs — and
  // inspect/format/formatWithOptions plus parseArgs through the util spoke
  // (lower-inspect.ts: per-type synthesized traversal helpers,
  // compile-time format strings, checked-dynamic config/result for
  // parseArgs), which both dispatch paths try before the generic table.
  // parseArgs is tabled as well so the generated surface manifest records
  // the dedicated static member; the spoke owns its optional arity and
  // call-site-specific result type before this canonical signature is used.
  util: {
    parseArgs: { fn: "util.parseArgs", params: [DYN], result: DYN },
  },
  // node:string_decoder's surface is the StringDecoder CLASS — new/write/
  // end are special-cased (lowerNew + lowerStringDecoderMethodCall); no
  // function members exist to table.
  string_decoder: {},
  // node:querystring — the legacy query-string codec (NOT URLSearchParams;
  // the escaping and '+' rules differ). escape/unescape ride the table
  // path directly; parse and stringify are special-cased in
  // lowerBuiltinModuleCall (parse's result is the call site's mapped
  // ParsedUrlQuery dictionary — the networkInterfaces verification stance
  // — and its sep/eq/options complete there; stringify's object argument
  // crosses as a dyn value). decode/encode are Node's own aliases of
  // parse/stringify (`const decode = parse` in lib/querystring.js) and
  // route to the same special cases; the entries carry canonical shapes.
  querystring: {
    parse: { fn: "qs.parse", params: [STRING], result: VOID },
    decode: { fn: "qs.parse", params: [STRING], result: VOID },
    stringify: { fn: "qs.stringify", params: [DYN], result: STRING },
    encode: { fn: "qs.stringify", params: [DYN], result: STRING },
    escape: { fn: "qs.escape", params: [STRING], result: STRING },
    unescape: { fn: "qs.unescape", params: [STRING], result: STRING },
  },
  // node:readline: createInterface's options are entirely special-cased
  // (exactly { input: process.stdin, output?: process.stdout } — see
  // lowerBuiltinModuleCall); the entry carries the canonical shape. The
  // interface's question/close/on lower through
  // lowerReadlineMethodCall.
  readline: {
    createInterface: { fn: "rl.create", params: [], result: F64 },
  },
  // node:net and node:http lower ENTIRELY through the server spoke
  // (lower-server.ts — every call shape is special-cased: closures, the
  // optional connect host, writeHead's literal headers); the member list
  // is the lower-server dispatch there. The modules still need keys here so future
  // table entries have a home, and so the "recognized module, unlowered
  // member" fence wording applies.
  net: {
    // The process-wide happy-eyeballs attempt budget: one runtime double
    // in the core unit (never links scr_net.c by itself), default 250ms
    // like Node's.
    getDefaultAutoSelectFamilyAttemptTimeout: { fn: "net.getAutoSelTimeout", params: [], result: F64 },
    setDefaultAutoSelectFamilyAttemptTimeout: { fn: "net.setAutoSelTimeout", params: [F64], result: VOID },
  },
  http: {},
  // node:tls and node:https ride the same spoke (tls.createServer's
  // options + secureConnection handler, https.createServer, and the
  // https client's rejectUnauthorized/ca options are all special-cased
  // in lower-server.ts).
  tls: {},
  https: {},
  // node:dgram and node:dns lower ENTIRELY through the dgram spoke
  // (lower-dgram.ts — createSocket's option literal, dns.lookup's
  // options + callback, and the Socket method surface are all
  // special-cased); the keys exist for the same reason net/http's do.
  dgram: {},
  dns: {},
  // node:assert lowers ENTIRELY through the assert spoke (lower-assert.ts
  // — every call shape is special-cased: optional messages complete, the
  // comparisons pick per-type libCalls, deep equality synthesizes
  // helpers); the keys exist so unlowered members fence module-qualified
  // with the hints below.
  assert: {},
  "assert/strict": {},
  // node:test lowers ENTIRELY through the test spoke (lower-test.ts —
  // registrations, suites, hooks, the TestContext surface); the key
  // exists so unlowered members fence module-qualified.
  test: {},
  // node:stream/promises lowers through the stream spoke too
  // (lower-stream.ts — finished/pipeline's promise forms special-case
  // their stream arguments exactly like the callback forms); the key
  // exists so unlowered members fence module-qualified.
  "stream/promises": {},
  // node:stream/consumers rides the stream spoke as well (text/json/
  // buffer special-case their stream argument); arrayBuffer and blob
  // fence module-qualified with the pointed hints below — neither value
  // has a representation in a compiled binary.
  "stream/consumers": {},
  // node:timers/promises — the delay-only setTimeout and bare setImmediate
  // (void promises the shared timer heap settles). The arity completion
  // (omitted delay = Node's 1ms) and the value/options fences are
  // special-cased in lowerBuiltinModuleCall; these entries carry the
  // canonical shapes and route the dispatch.
  "timers/promises": {
    setTimeout: { fn: "tp.setTimeout", params: [F64], result: { kind: "promise", inner: VOID } },
    setImmediate: { fn: "tp.setImmediate", params: [], result: { kind: "promise", inner: VOID } },
  },
  // node:diagnostics_channel — the pub/sub core. channel() answers an f64
  // handle (type-mapper.ts maps Channel to F64); the subscriber arguments box
  // into the checked-dynamic tree (special-cased in lowerBuiltinModuleCall — the entries
  // carry canonical shapes and route the dispatch). The Channel method
  // surface lowers through lowerDcChannelMethodCall/lowerDcChannelProperty.
  diagnostics_channel: {
    channel: { fn: "dc.channel", params: [STRING], result: F64 },
    subscribe: { fn: "dc.subscribe", params: [STRING, DYN], result: VOID },
    unsubscribe: { fn: "dc.unsubscribe", params: [STRING, DYN], result: BOOL },
    hasSubscribers: { fn: "dc.hasSubscribers", params: [STRING], result: BOOL },
    // The string form's canonical shape; the collection form (an object
    // literal of five Channels) is special-cased in lowerBuiltinModuleCall.
    tracingChannel: { fn: "dc.tracingChannel", params: [STRING], result: F64 },
  },
};

/** Builtin-module CONSTANTS (value reads of named imports): each lowers to
 * a literal of its value's kind. The bare-module values are the TARGET
 * platform's (builtinModuleConstOf swaps the win32 values in under a win32
 * triple — Node's own platform conditionals); the named namespaces answer
 * THEIR platform's constants everywhere. worker_threads/cluster carry the
 * main-thread truths: a compiled binary IS the main thread (no JS-engine
 * thread machinery) and never runs as a cluster worker (cluster forks the
 * node binary itself) — Node's own answers for a directly-run script. */
export const BUILTIN_MODULE_CONSTS: Record<string, Record<string, string | number | boolean | undefined> | undefined> = {
  path: { sep: "/", delimiter: ":" },
  "path/posix": { sep: "/", delimiter: ":" },
  "path/win32": { sep: "\\", delimiter: ";" },
  os: { EOL: "\n" },
  worker_threads: { isMainThread: true, threadId: 0 },
  cluster: { isPrimary: true, isMaster: true, isWorker: false },
};

/** ALTERNATE libCall spellings of tabled builtin members: lowerings the
 * dispatch special-cases around the table row (Buffer/fd/options forms,
 * the JS checked-validation variants) still ARE the member's surface —
 * the sidecar's determinism attestation demotes on them by prefix, so the
 * member's fence detector must witness them too (fencing one spelling
 * fences the operation, the trimLeft/trimStart rule). Keyed like
 * BUILTIN_MODULE_FNS; consumed by the fence taxonomy
 * (library/fence-eval.ts) and the attestation-parity test. */
export const BUILTIN_MODULE_FN_ALIASES: Record<string, Record<string, readonly IrLibFn[] | undefined> | undefined> = {
  fs: {
    // The Buffer form (no encoding), the fd forms (readFileSync(fd[,
    // "utf8"])), and the checked-dynamic encoding form.
    readFileSync: ["fs.readFileSyncBuf", "fs.readFileSyncBytes", "fs.readFileSyncDyn", "fs.readFdSync", "fs.readFdSyncBytes"],
    // The bytes-data form and the { mode } options form.
    writeFileSync: ["fs.writeFileSyncBytes", "fs.writeFileModeSync"],
    // The utf8 string overload; the table row is the Buffer-window form.
    writeSync: ["fs.writeStrSync"],
    // The { recursive, mode } option lowerings.
    mkdirSync: ["fs.mkdirModeSync", "fs.mkdirRecursiveSync", "fs.mkdirRecursiveModeSync"],
    // The { recursive, force } and maxRetries/retryDelay option lowerings.
    rmSync: ["fs.rmOptsSync", "fs.rmRetrySync"],
    // The { withFileTypes: true } Dirent form.
    readdirSync: ["fs.readdirTypesSync"],
    // The JS-source validation-ladder variant (lowerFsLadderCall): the
    // real mkdtemp runs when the options leave utf8 semantics.
    mkdtempSync: ["fs.mkdtempSyncChk"],
    // lchmodSync is chmod's no-follow spelling, JS-ladder only (TypeScript
    // callers fence per site); the ladder runs the REAL lchmod on APPLE,
    // so the chmod fence witnesses it — fencing one spelling fences the
    // operation.
    chmodSync: ["fs.lchmodSyncChk"],
    // The two-argument listener form.
    watch: ["fs.watchCb"],
  },
  "fs/promises": {
    // The Buffer form (no encoding).
    readFile: ["fsp.readFileBytes"],
    // The string-data { mode } options form.
    writeFile: ["fsp.writeFileMode"],
  },
  crypto: {
    // The composed randomBytes(n).toString(enc) chain keeps its one-libCall
    // lowering (lowerCryptoComposedCall) — same surface, no Buffer.
    randomBytes: ["crypto.randomBytesToString"],
  },
  os: {
    // lowerOsUserInfoCall assembles the record from scalar libCalls.
    userInfo: ["os.userHomedir", "os.userShell"],
  },
};

/** Ambient surfaces lowered through DEDICATED code paths (no lowering-table
 * row): the Date compositions, perf_hooks' performance.now, and the process
 * global's ambient reads and authority calls. These are the determinism
 * attestation's ground (ir/ir.ts's LIB_NONDETERMINISTIC_PREFIXES), so
 * each row projects one surface-manifest entry — a permanent, fenceable id
 * — and carries the libCall spellings that witness the surface's reach in
 * a compiled graph (the fence detector and the attestation must agree; the
 * parity test in tests/harness/surface-manifest.test.ts holds them to it). */
export interface AmbientSurfaceRow {
  /** The manifest entry id (stable diff key — permanent API). */
  id: string;
  kind: "stdlib" | "node-builtin";
  /** Human-readable surface name (the manifest's `name`). */
  name: string;
  /** The IrLibFn spellings whose reach witnesses the surface. */
  fns: readonly IrLibFn[];
  note?: string;
}

export const AMBIENT_SURFACE_FNS: readonly AmbientSurfaceRow[] = [
  // ── the Date slice (lowerDateCall/lowerNew): statics, construction,
  // stored read-only values, calendar getters, and ISO formatting.
  {
    id: "stdlib.date.now",
    kind: "stdlib",
    name: "Date.now",
    fns: ["date.now"],
    note: "the live clock",
  },
  {
    id: "stdlib.date.constructor",
    kind: "stdlib",
    name: "Date constructor",
    fns: ["date.newNow", "date.newMs", "date.newString"],
    note: "zero arguments, or one milliseconds/date-string argument; values are the read-only TimeClip scalar slice",
  },
  {
    id: "stdlib.date.UTC",
    kind: "stdlib",
    name: "Date.UTC",
    fns: ["date.utc"],
    note: "the lowered call form takes 1 to 7 number arguments",
  },
  {
    id: "stdlib.date.getTime",
    kind: "stdlib",
    name: "Date.prototype.getTime",
    fns: ["date.getTime", "date.parseGetTime"],
    note: "the millisecond value of a stored Date",
  },
  {
    id: "stdlib.date.valueOf",
    kind: "stdlib",
    name: "Date.prototype.valueOf",
    fns: ["date.valueOf"],
    note: "the same millisecond read as getTime()",
  },
  {
    id: "stdlib.date.toISOString",
    kind: "stdlib",
    name: "Date.prototype.toISOString",
    fns: ["date.toISOString", "date.toISOStringValue"],
    note: "UTC ISO formatting over constructed and stored Date values",
  },
  { id: "stdlib.date.getFullYear", kind: "stdlib", name: "Date.prototype.getFullYear", fns: ["date.getFullYear"] },
  { id: "stdlib.date.getUTCFullYear", kind: "stdlib", name: "Date.prototype.getUTCFullYear", fns: ["date.getUTCFullYear"] },
  { id: "stdlib.date.getMonth", kind: "stdlib", name: "Date.prototype.getMonth", fns: ["date.getMonth"] },
  { id: "stdlib.date.getUTCMonth", kind: "stdlib", name: "Date.prototype.getUTCMonth", fns: ["date.getUTCMonth"] },
  { id: "stdlib.date.getDate", kind: "stdlib", name: "Date.prototype.getDate", fns: ["date.getDate"] },
  { id: "stdlib.date.getUTCDate", kind: "stdlib", name: "Date.prototype.getUTCDate", fns: ["date.getUTCDate"] },
  { id: "stdlib.date.getDay", kind: "stdlib", name: "Date.prototype.getDay", fns: ["date.getDay"] },
  { id: "stdlib.date.getUTCDay", kind: "stdlib", name: "Date.prototype.getUTCDay", fns: ["date.getUTCDay"] },
  { id: "stdlib.date.getHours", kind: "stdlib", name: "Date.prototype.getHours", fns: ["date.getHours"] },
  { id: "stdlib.date.getUTCHours", kind: "stdlib", name: "Date.prototype.getUTCHours", fns: ["date.getUTCHours"] },
  { id: "stdlib.date.getMinutes", kind: "stdlib", name: "Date.prototype.getMinutes", fns: ["date.getMinutes"] },
  { id: "stdlib.date.getUTCMinutes", kind: "stdlib", name: "Date.prototype.getUTCMinutes", fns: ["date.getUTCMinutes"] },
  { id: "stdlib.date.getSeconds", kind: "stdlib", name: "Date.prototype.getSeconds", fns: ["date.getSeconds"] },
  { id: "stdlib.date.getUTCSeconds", kind: "stdlib", name: "Date.prototype.getUTCSeconds", fns: ["date.getUTCSeconds"] },
  { id: "stdlib.date.getMilliseconds", kind: "stdlib", name: "Date.prototype.getMilliseconds", fns: ["date.getMilliseconds"] },
  { id: "stdlib.date.getUTCMilliseconds", kind: "stdlib", name: "Date.prototype.getUTCMilliseconds", fns: ["date.getUTCMilliseconds"] },
  { id: "stdlib.date.getTimezoneOffset", kind: "stdlib", name: "Date.prototype.getTimezoneOffset", fns: ["date.getTimezoneOffset"] },
  // ── perf_hooks (lowerPerfHooksCall): the monotonic clock.
  {
    id: "node-builtin.perf_hooks.performance.now",
    kind: "node-builtin",
    name: "perf_hooks.performance.now",
    fns: ["perf.now"],
    note: "the global performance object and the performance.now.bind(performance) function value reach the same clock",
  },
  // ── the process global's ambient reads and authority calls
  // (lowerProcessProperty/lowerProcessMethodCall — process is a
  // provenance-checked global here, not an importable module).
  {
    id: "node-builtin.process.env",
    kind: "node-builtin",
    name: "process.env",
    fns: ["process.envGet", "process.envSet", "process.envUnset", "process.envPairs"],
    note: "reads, writes, deletes, and enumeration of the process environment (the process global)",
  },
  { id: "node-builtin.process.argv", kind: "node-builtin", name: "process.argv", fns: ["process.argv"] },
  { id: "node-builtin.process.cwd", kind: "node-builtin", name: "process.cwd", fns: ["process.cwd"] },
  { id: "node-builtin.process.chdir", kind: "node-builtin", name: "process.chdir", fns: ["process.chdir"] },
  { id: "node-builtin.process.pid", kind: "node-builtin", name: "process.pid", fns: ["process.pid"] },
  { id: "node-builtin.process.getuid", kind: "node-builtin", name: "process.getuid", fns: ["process.getuid"] },
  { id: "node-builtin.process.getgid", kind: "node-builtin", name: "process.getgid", fns: ["process.getgid"] },
  { id: "node-builtin.process.execPath", kind: "node-builtin", name: "process.execPath", fns: ["process.execPath"] },
  { id: "node-builtin.process.uptime", kind: "node-builtin", name: "process.uptime", fns: ["process.uptime"] },
  {
    id: "node-builtin.process.availableMemory",
    kind: "node-builtin",
    name: "process.availableMemory",
    fns: ["process.availableMemory"],
  },
  {
    id: "node-builtin.process.constrainedMemory",
    kind: "node-builtin",
    name: "process.constrainedMemory",
    fns: ["process.constrainedMemory"],
  },
  {
    id: "node-builtin.process.resourceUsage",
    kind: "node-builtin",
    name: "process.resourceUsage",
    fns: ["process.rusage"],
    note: "getrusage's 16 fields — every field read samples live machine state",
  },
  {
    id: "node-builtin.process.cpuUsage",
    kind: "node-builtin",
    name: "process.cpuUsage",
    fns: ["process.cpuUser", "process.cpuSystem", "process.cpuUserDiff", "process.cpuSystemDiff", "process.cpuPrevValidate"],
    note: "the plain-sample and previous-value diff forms are one surface",
  },
  {
    id: "node-builtin.process.threadCpuUsage",
    kind: "node-builtin",
    name: "process.threadCpuUsage",
    fns: ["process.threadCpuUser", "process.threadCpuSystem", "process.threadCpuUserDiff", "process.threadCpuSystemDiff"],
    note: "the plain-sample and previous-value diff forms are one surface",
  },
  {
    id: "node-builtin.process.isTTY",
    kind: "node-builtin",
    name: "process.isTTY",
    fns: ["process.isTTY"],
    note: "the isTTY read on process.stdin/stdout/stderr — one surface across the three streams",
  },
  {
    id: "node-builtin.process.columns",
    kind: "node-builtin",
    name: "process.columns",
    fns: ["process.columns"],
    note: "the columns read on the process stdio streams (terminal geometry)",
  },
  {
    id: "node-builtin.process.kill",
    kind: "node-builtin",
    name: "process.kill",
    fns: ["process.kill", "process.killNum"],
    note: "the signal-name and signal-number forms are one surface",
  },
  { id: "node-builtin.process.umask", kind: "node-builtin", name: "process.umask", fns: ["process.umask"] },
  {
    id: "node-builtin.process.exit",
    kind: "node-builtin",
    name: "process.exit",
    fns: ["process.exit", "process.exiting"],
    note: "process.exit and the process._exiting flag read are one surface",
  },
  // ── the tls CA store (lowerTlsCaCall / lowerTlsRootCertificates): the
  // host's trust anchors, read and replaced. Dedicated paths, and
  // rootCertificates is a VALUE read with no call form at all, so none of
  // the three can hang off a lowering-table row. Split three ways rather
  // than folded into one "CA store" surface: a library author who denies
  // REPLACING the trust anchors is making a different decision from one
  // who denies reading them, and each Node spelling is the name they will
  // reach for when writing the fence.
  {
    id: "node-builtin.tls.getCACertificates",
    kind: "node-builtin",
    name: "tls.getCACertificates",
    fns: ["tlsca.get"],
    note: "the per-type cached PEM bundle: 'default' and 'extra' additionally read NODE_EXTRA_CA_CERTS, 'system' the platform store",
  },
  {
    id: "node-builtin.tls.rootCertificates",
    kind: "node-builtin",
    name: "tls.rootCertificates",
    fns: ["tlsca.root"],
    note: "the value read; answers the same bundled array as getCACertificates('bundled'), but fenced under its own id — the spelling an author writes",
  },
  {
    id: "node-builtin.tls.setDefaultCACertificates",
    kind: "node-builtin",
    name: "tls.setDefaultCACertificates",
    fns: ["tlsca.set"],
    note: "replaces the default set and the client trust anchors for the rest of the process",
  },
];

/** The win32-target overrides of the bare modules' constants: path's
 * constants ARE the path/win32 namespace's, and os.EOL is CRLF (Node's
 * `isWindows ? '\r\n' : '\n'`). */
const WIN32_TARGET_CONSTS: Record<string, Record<string, string | number | boolean | undefined> | undefined> = {
  path: BUILTIN_MODULE_CONSTS["path/win32"],
  os: { EOL: "\r\n" },
};

/** url's win32-target table: fileURLToPath is receiver-form-special-cased
 * either way, and pathToFileURL swaps to its win32 IR flavor (the same
 * runtime call, but in the may-throw seed — Node's win32 arm raises UNC
 * TypeErrors where the posix arm never throws). */
const URL_WIN32_MODULE_FNS: Record<string, BuiltinModuleFn | undefined> = {
  fileURLToPath: { fn: "url.fileURLToPathStr", params: [STRING], result: STRING },
  pathToFileURL: { fn: "url.pathToFileURLWin32", params: [STRING], result: URL_T },
};

/** BUILTIN_MODULE_FNS with the platform-conditional modules bound per
 * TARGET: a win32 triple compiles Node-on-Windows semantics — `path` is
 * path.win32 and url's bridge takes the win32 flavors. Fence wording is
 * unaffected — callers keep naming the module the source spelled. */
function builtinModuleFnsOf(lowerer: Lowerer, module: string): Record<string, BuiltinModuleFn | undefined> | undefined {
  if (lowerer.targetPlatform === "win32") {
    if (module === "path") return BUILTIN_MODULE_FNS["path/win32"];
    if (module === "url") return URL_WIN32_MODULE_FNS;
  }
  return ownEntry(BUILTIN_MODULE_FNS, module);
}

/** Own-property lookup — lowerer.ts's own(), duplicated locally because
 * lowerer.ts already imports surfaces.ts (a value import back would
 * cycle). The tables here are plain object literals keyed by USER-written
 * module/member names, so a bare index would also find Object.prototype
 * members ("toString", "constructor", "__proto__"). */
function ownEntry<T>(table: Record<string, T | undefined>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** One MEMBER's table entry, own-property-safe (`path.toString` must not
 * answer Object.prototype.toString as a BuiltinModuleFn). */
export function builtinModuleFnOf(lowerer: Lowerer, module: string, member: string): BuiltinModuleFn | undefined {
  const mod = builtinModuleFnsOf(lowerer, module);
  return mod ? ownEntry(mod, member) : undefined;
}

/** One member's fence hint, own-property-safe (a collision would print an
 * inherited function into the diagnostic text). */
export function builtinFenceHintOf(module: string, member: string): string | undefined {
  const mod = ownEntry(BUILTIN_MODULE_FENCE_HINTS, module);
  return mod ? ownEntry(mod, member) : undefined;
}

/** BUILTIN_MODULE_CONSTS with the win32-target overrides applied — the
 * constants twin of builtinModuleFnsOf. */
export function builtinModuleConstOf(lowerer: Lowerer, module: string, member: string): string | number | boolean | undefined {
  if (lowerer.targetPlatform === "win32") {
    const mod = ownEntry(WIN32_TARGET_CONSTS, module);
    const w = mod ? ownEntry(mod, member) : undefined;
    if (w !== undefined) return w;
  }
  const mod = ownEntry(BUILTIN_MODULE_CONSTS, module);
  return mod ? ownEntry(mod, member) : undefined;
}

/** The IR literal of a builtin-module constant — one place so both value
 * paths (named-import bindings and namespace member reads) emit the same
 * kinds. */
export function builtinConstLit(value: string | number | boolean, loc: { file: string; start: number; end: number }): IrExpr {
  if (typeof value === "string") return { kind: "strLit", value, type: STRING, loc };
  if (typeof value === "number") return { kind: "numLit", value, type: F64, loc };
  return { kind: "boolLit", value, type: BOOL, loc };
}

/** node:module's builtinModules, BAKED — Node v24's exact list (verbatim
 * order: the bare names, then the node:-prefix-only tails), pinned to
 * the compat target rather than read from the COMPILING host's Node so
 * emitted programs are host-independent (the cache-identity contract).
 * Node ships one frozen singleton; each read here mints a fresh string
 * array — a divergence only mutation could observe, and mutating Node's
 * frozen array throws anyway. */
const NODE_BUILTIN_MODULES_V24: readonly string[] = [
  "_http_agent", "_http_client", "_http_common", "_http_incoming",
  "_http_outgoing", "_http_server", "_stream_duplex", "_stream_passthrough",
  "_stream_readable", "_stream_transform", "_stream_wrap", "_stream_writable",
  "_tls_common", "_tls_wrap", "assert", "assert/strict", "async_hooks",
  "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events",
  "fs", "fs/promises", "http", "http2", "https", "inspector",
  "inspector/promises", "module", "net", "os", "path", "path/posix",
  "path/win32", "perf_hooks", "process", "punycode", "querystring",
  "readline", "readline/promises", "repl", "stream", "stream/consumers",
  "stream/promises", "stream/web", "string_decoder", "sys", "timers",
  "timers/promises", "tls", "trace_events", "tty", "url", "util",
  "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
  "node:sea", "node:sqlite", "node:test", "node:test/reporters",
];

/** The array-literal read of module.builtinModules — both value paths
 * (the named-import binding and the namespace member read) mint the
 * same fresh string[]. */
export function builtinModulesArrayLit(loc: { file: string; start: number; end: number }): IrExpr {
  return {
    kind: "arrayLit",
    elems: NODE_BUILTIN_MODULES_V24.map(
      (m): IrExpr => ({ kind: "strLit", value: m, type: STRING, loc }),
    ),
    type: arrayOf(STRING),
    loc,
  };
}

/** Member-specific hints for RECOGNIZED builtin modules whose member has
 * no lowering. deflateSync/inflateSync lower now (Buffers are real);
 * the rest of the zlib surface points at the lowered pair. */
const ZLIB_HINT =
  "deflateSync and inflateSync are the lowered zlib surface";

/** The loose-equality quartet's shared hint: == coercion has no lowering
 * anywhere in this compiler, and Node itself points at the strict forms. */
const ASSERT_LOOSE_HINT =
  "loose == equality has no lowering — the strict forms compare with " +
  "Object.is/structural equality like Node's assert/strict module, where " +
  "equal IS strictEqual";

const ASSERT_MODULE_HINTS: Record<string, string | undefined> = {
  equal: ASSERT_LOOSE_HINT,
  notEqual: ASSERT_LOOSE_HINT,
  deepEqual: ASSERT_LOOSE_HINT,
  notDeepEqual: ASSERT_LOOSE_HINT,
  ifError:
    "test explicitly instead: assert.strictEqual(err, null) / " +
    "assert.strictEqual(err, undefined)",
  rejects:
    "await the promise inside assert.throws's callback story instead: " +
    "try { await p; assert.fail(\"expected rejection\") } catch { ... }",
  doesNotReject: "await the promise directly — an unexpected rejection already fails the test",
  doesNotThrow: "call the function directly — an unexpected throw already fails the test",
  AssertionError:
    "the class itself has no lowering — catch and test err.name === " +
    '"AssertionError" or err.code === "ERR_ASSERTION"',
};

export const BUILTIN_MODULE_FENCE_HINTS: Record<string, Record<string, string | undefined> | undefined> = {
  assert: ASSERT_MODULE_HINTS,
  // The strict module's equal/notEqual/deepEqual/notDeepEqual ARE the
  // strict comparisons (aliased in the spoke) — only the members with no
  // lowering in either module fence here.
  "assert/strict": {
    ifError: ASSERT_MODULE_HINTS["ifError"],
    rejects: ASSERT_MODULE_HINTS["rejects"],
    doesNotReject: ASSERT_MODULE_HINTS["doesNotReject"],
    doesNotThrow: ASSERT_MODULE_HINTS["doesNotThrow"],
    AssertionError: ASSERT_MODULE_HINTS["AssertionError"],
  },
  util: {
    promisify:
      "the one lowered shape is a const binding over child_process.execFile: " +
      "const execFileAsync = promisify(execFile), then call execFileAsync directly",
    // child_process.execFile itself exists to be promisified — the same
    // story from the other end.
  },
  "stream/consumers": {
    arrayBuffer:
      "no free-standing ArrayBuffer value exists here (typed arrays own their storage) — " +
      "buffer(stream) collects the same bytes as a Buffer",
    blob:
      "Blob values have no representation in a compiled binary — " +
      "buffer(stream) collects the same bytes as a Buffer, text(stream) the decoded text",
  },
  module: {
    createRequire:
      "the lowered shape is a const binding over createRequire(import.meta.url) (or __filename) " +
      "whose require calls take STATIC string literals — builtins, relative .json documents, " +
      "and installed npm packages (under --dynamic) resolve at build time; " +
      "dynamic specifiers cannot exist in a compiled binary's fixed module graph",
    isBuiltin:
      "builtinModules.includes(name) answers the same question over the baked list " +
      "(strip a node: prefix first; the prefix-only builtins appear with it, as node:test)",
    syncBuiltinESMExports:
      "a compiled program has no live builtin ESM namespace bindings to synchronize — " +
      "nothing a compiled surface can mutate makes the call observable; remove it",
  },
  child_process: {
    execFile:
      "the callback form has no lowering — promisify it: " +
      "const execFileAsync = promisify(execFile) (from node:util), or use execFileSync",
  },
  crypto: {
    createHash:
      "the one lowered shape is the composed chain " +
      'createHash("sha256").update(data).digest("hex") — the Hash handle itself has no lowering',
    hash:
      "the one-shot digest has no lowering — the composed chain " +
      'createHash("sha256").update(data).digest("hex") is the lowered hashing surface',
    createHmac:
      "HMAC has no lowering yet — the lowered crypto surface is randomUUID, randomBytes, " +
      'the createHash("sha256"|"sha1") chain, and the introspection statics',
    ...Object.fromEntries(
      [
        "generateKeyPair", "generateKeyPairSync", "generateKey", "generateKeySync",
        "createPrivateKey", "createPublicKey", "createSecretKey",
        "createSign", "createVerify", "sign", "verify",
        "createDiffieHellman", "createDiffieHellmanGroup", "getDiffieHellman",
        "createECDH", "diffieHellman",
        "publicEncrypt", "publicDecrypt", "privateEncrypt", "privateDecrypt",
      ].map((m) => [
        m,
        "asymmetric-key operations need a public-key stack (bignum, RSA/EC/EdDSA math) and a " +
          "KeyObject value model — neither exists in the static runtime, so no faithful lowering " +
          "can be small; the lowered crypto surface is hashing, randomness, and the introspection statics",
      ]),
    ),
    ...Object.fromEntries(
      ["createCipheriv", "createDecipheriv", "getCipherInfo"].map((m) => [
        m,
        "symmetric ciphers need a cipher stack the static runtime does not vendor — " +
          "the lowered crypto surface is hashing, randomness, and the introspection statics",
      ]),
    ),
    ...Object.fromEntries(
      ["pbkdf2", "pbkdf2Sync", "scrypt", "scryptSync", "hkdf", "hkdfSync"].map((m) => [
        m,
        "key-derivation functions have no lowering yet — the lowered crypto surface is " +
          "hashing, randomness, and the introspection statics",
      ]),
    ),
    setFips:
      "a compiled binary has no FIPS provider to enable, and Node itself throws on setFips(true) " +
      "in a non-FIPS build — getFips() answers 0 here",
    webcrypto:
      "the WebCrypto object has no lowering — the lowered crypto surface is randomUUID, " +
      "randomBytes, and the createHash chain",
  },
  zlib: {
    gzipSync: ZLIB_HINT,
    gunzipSync: ZLIB_HINT,
    unzipSync: ZLIB_HINT,
    brotliCompressSync: ZLIB_HINT,
    brotliDecompressSync: ZLIB_HINT,
  },
  http2: {
    connect:
      "HTTP/2 client sessions have no lowering — the lowered http2 surface is the SERVER side: " +
      "createSecureServer({ allowHTTP1: true, cert, key }), which serves HTTP/1.1 only " +
      "(ALPN never offers h2 — h2-capable clients negotiate down); an HTTP/1.1 client is https.request",
    createServer:
      "cleartext (h2c) servers have no lowering — the lowered http2 surface is " +
      "createSecureServer({ allowHTTP1: true, cert, key }), which serves HTTP/1.1 over TLS " +
      "(plain HTTP/1.1 is http.createServer)",
  },
  tls: {
    createSecureContext:
      "the lowered form is createSecureContext({ cert, key }) — an opaque SecureContext handle " +
      "for SNI callbacks (http2.createSecureServer accepts SNICallback); other options fence by name",
    connect:
      "the lowered TLS client is https.request({ hostname, port, path, method, ca?, rejectUnauthorized? }); " +
      "raw tls.connect sockets have no lowering yet",
  },
};

/** The MEMBER chokepoint of the lib fence: called from the property-read
   * and method-call fallbacks after every lowering has passed. When the
   * accessed member is stdlib-declared, the use is standard-library surface
   * with no lowering — report SC2020 naming `<container>.<member>` (the
   * receiver's global name when it IS a stdlib global like Math or Promise,
   * its widened type text otherwise). Returns silently for non-stdlib
   * members so the caller's generic rejection applies. */
  export function stdlibMemberFence(lowerer: Lowerer, access: ts.PropertyAccessExpression): void {
    const sym = lowerer.checker.getSymbolAtLocation(access.name);
    if (!sym || !lowerer.isStdlibSymbol(sym)) return;
    const member = access.name.text;
    const recv = access.expression;
    // A CHECKED-DYNAMIC receiver whose checker type is a concrete stdlib
    // class mapped to dyn (the http Agent handle): its members dispatch
    // at runtime through the dyn/handle machinery — the keyed-read claim
    // below this fence answers, member-or-refusal ladder, so no compile
    // fence belongs here.
    if (lowerer.mapTypeOf(lowerer.typeOf(recv))?.kind === "dyn") return;
    // Name the container the way the source reads: the global's name when
    // the receiver IS a stdlib global (Math, process), the dotted path for
    // a member of one (process.stdout — its TYPE text would be the useless
    // 'WriteStream & { fd: 1; }'), the receiver's widened type text
    // otherwise.
    const globalPathOf = (e: ts.Expression): string | null => {
      if (ts.isIdentifier(e) && lowerer.isStdlibSymbol(lowerer.checker.getSymbolAtLocation(e))) {
        return e.text;
      }
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        const base = globalPathOf(e.expression);
        if (base !== null) return `${base}.${e.name.text}`;
      }
      return null;
    };
    const container =
      globalPathOf(recv) ??
      lowerer.checker.typeToString(lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(recv)));
    let hint: string | undefined;
    const recvIr = lowerer.mapTypeOf(lowerer.typeOf(recv));
    if (recvIr?.kind === "promise" && (member === "then" || member === "catch" || member === "finally")) {
      hint =
        "'await' is the supported way to chain (p.then(f) with one fulfillment handler, p.catch " +
        "with an INLINE handler, and p.finally(cb) compile) — try { await p } catch (e) is the general form";
    } else if (recvIr?.kind === "f64" && member === "toString") {
      hint = "radix-free conversion is a template literal away: `${x}`; toString(radix) runs under --dynamic";
    } else if (container === "Math" && (member === "min" || member === "max")) {
      hint =
        `Math.${member} lowers with any number of plain arguments or ONE number[] spread — ` +
        `mixed spread/positional lists don't: spread a single array (Math.${member}(...xs))`;
    } else if (
      recvIr?.kind === "array" &&
      member === "index" &&
      (container === "RegExpExecArray" || container === "RegExpMatchArray")
    ) {
      hint =
        "'.index' is supported on the const binding of a for-of over a DIRECT matchAll call " +
        "(for (const m of s.matchAll(re)) { ... m.index ... }); stored rows are honest " +
        "string[] slices without it";
    } else if (
      recvIr?.kind === "array" &&
      member === "groups" &&
      (container === "RegExpExecArray" || container === "RegExpMatchArray")
    ) {
      hint =
        "'.groups' lowers when the match's regex is STATICALLY known — a regex literal, or a " +
        "const initialized with one (the group-name table is built at compile time) — and the " +
        "read is not an optional-chain step: narrow the match instead (if (m) { m.groups } or " +
        "m!.groups)";
    } else if (recvIr?.kind === "array" && member === "flat") {
      hint =
        "flat has no lowering (flatMap does) — flatten into an accumulator instead: " +
        "for (const x of xs) for (const y of x) out.push(y)";
    } else if (
      recvIr?.kind === "object" &&
      RUNTIME_ERROR_CLASSES.has(recvIr.className) &&
      member === "stack"
    ) {
      hint =
        "stack traces are not captured (frames would need runtime bookkeeping); " +
        "name, message, and toString() are available";
    } else if (container === "process.stdin" || (container === "process" && member === "stdin")) {
      hint =
        "isTTY, destroy(), on/once of the data/end/error events, and " +
        "`for await (const chunk of process.stdin)` are the supported stdin surface " +
        '(or read everything at once: readFileSync(0, "utf8") from node:fs)';
    } else if (
      (container === "process" && (member === "stdout" || member === "stderr")) ||
      container === "process.stdout" ||
      container === "process.stderr"
    ) {
      // @types/node territory: the fallback declarations don't have these
      // members at all (a type error), so this fence only fires with the
      // project's real Node types adopted.
      hint =
        "console.log is the supported way to write a line to stdout; " +
        "the stdout/stderr stream objects have no lowering";
    } else if (container === "console") {
      hint =
        "console.log/info/debug (stdout) and console.error/warn (stderr) are the supported " +
        "console surface (arguments render with Node's console semantics: strings verbatim, " +
        "everything else through the static util.inspect)";
    } else if (container === "TextEncoder") {
      hint =
        "the inline new TextEncoder().encode(s) form and same-scope const store-then-call " +
        "(const encoder = new TextEncoder(); encoder.encode(s)) compile; captured/imported " +
        "instances and other members need a runtime object representation";
    } else if (container === "TextDecoder") {
      hint =
        "the inline new TextDecoder(<literal label>).decode(bytes) form and same-scope const store-then-call " +
        "(const decoder = new TextDecoder(<literal label>); decoder.decode(bytes)) compile; captured/imported " +
        "instances, streaming state, and other members need a runtime object representation";
    } else if (member === "prototype") {
      hint =
        "prototype objects are not values here (method lookup is static) — call the method on an instance instead";
    } else if (
      recvIr?.kind === "func" &&
      (member === "call" || member === "apply" || member === "bind")
    ) {
      hint =
        "call the function directly — plain and arrow functions here never read `this`, so " +
        "f.call(thisArg, ...args) is f(...args), and bind's partial application is an arrow: (...rest) => f(a, ...rest)";
    } else if (
      recvIr?.kind === "string" &&
      (member === "match" || member === "matchAll" || member === "search")
    ) {
      hint =
        "the regex-LITERAL argument forms lower (s.match(/re/)); a string pattern constructs " +
        "a RegExp at runtime, which has no lowering";
    } else if (container === "ArrayBuffer" || container.startsWith("ArrayBuffer<")) {
      hint =
        "resize/transfer/maxByteLength need the buffer to exist as a runtime value, and no " +
        "free-standing ArrayBuffer value does — typed arrays own fixed-length storage " +
        "(new Uint8Array(n)); allocate a new view and copy instead";
    } else if (container === "SharedArrayBuffer" || container.startsWith("SharedArrayBuffer<")) {
      hint =
        "no shared-memory threads exist in a compiled program — Uint8Array is the byte storage " +
        "(a fixed-length allocation: grow has nothing to share it with)";
    } else if (
      container === "Intl" || container.startsWith("Intl.") ||
      ["NumberFormat", "DateTimeFormat", "DurationFormat", "PluralRules", "Collator", "Locale",
        "RelativeTimeFormat", "ListFormat", "Segmenter", "DisplayNames"].includes(container) ||
      member === "toLocaleString" || member === "toLocaleDateString" ||
      member === "toLocaleTimeString" || member === "toLocaleLowerCase" ||
      member === "toLocaleUpperCase"
    ) {
      hint =
        "locale- and ICU-backed behavior lives outside the static runtime (the localeCompare " +
        "stance: code-unit order, no collation/locale data) — what lowers: the composed " +
        'new Intl.NumberFormat("en-US").format(x) and x.toLocaleString("en-US") with default ' +
        "options; format with template literals, toFixed, and toString otherwise";
    } else if (container === "Object" && member === "assign") {
      hint =
        "spread instead: { ...a, ...b } builds the merged record; what lowers: the empty-target " +
        "literal-source shape (Object.assign({}, { ... }) IS the source literal) and merges INTO " +
        "an index-signature record whose value slot every source value enters — " +
        "other aliased targets are real mutation, and a function target (Object.assign(fn, { prop })) " +
        "is a function-with-properties value the model cannot represent: bind the property separately";
    }
    lowerer.noLowering(`${container}.${member}`, access, hint, sym);
  }

/** True iff the accessed member is declared by the standard library —
   * the same technique as isConsoleLog: trust declarations, not names. */
  export function isStdlibMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
    const direct = lowerer.checker.getSymbolAtLocation(access.name);
    if (direct) return lowerer.isStdlibSymbol(direct);
    // An IMPLICIT-ANY instance body (the checker sees an `any` receiver —
    // no member symbol resolves) or an ALIASED-TYPEOF narrow (the checker
    // sees the un-narrowed union — `val.length` on String|Number has no
    // property symbol): typeOf answers the bound/narrowed type — resolve
    // the member from it, the same provenance answer the checker would
    // give on a typed receiver (`path.startsWith` with path bound string
    // IS String.prototype.startsWith).
    if (lowerer.implicitParamTypes !== null || lowerer.aliasNarrowTypes.size > 0) {
      const viaType = lowerer.checker.getPropertyOfType(lowerer.typeOf(access.expression), access.name.text);
      return lowerer.isStdlibSymbol(viaType ?? undefined);
    }
    return false;
  }

/** The provenance check the CHILD receiver lowerings use: a stdlib
   * member, OR a member the user's own child-shaped interface declares
   * (the NgrokChildProcess idiom — mapType's duck rule admits an
   * interface only when EVERY member names the lowered ChildProcess
   * surface, so accepting its members here cannot widen the surface;
   * the receiver-kind gate already proved the type maps to child). */
  export function isChildSurfaceMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
    if (isStdlibMember(lowerer, access)) return true;
    const sym = lowerer.checker.getSymbolAtLocation(access.name);
    const decl = sym ? lowerer.checker.declarationsOf(sym)[0] : undefined;
    const iface = decl?.parent;
    if (!decl || !iface || !ts.isInterfaceDeclaration(iface)) return false;
    if (lowerer.isStdlibFile(decl.getSourceFile())) return false;
    return lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(iface.name))?.kind === "child";
  }

/** True iff some declaration of the symbol lives in the standard library
   * (shipped ambient or default lib — the provenance half of every
   * supported-surface check). `some`, not `[0]`: divergence overrides merge
   * with lib interfaces, so a member can carry declarations from both. A
   * user's own declaration is in neither, so shadowing never matches. */
  export function isStdlibSymbol(lowerer: Lowerer, symbol: ts.Symbol | undefined): boolean {
    return !!symbol && lowerer.checker.declarationsOf(symbol).some((d) => lowerer.isStdlibFile(d.getSourceFile()));
  }

/** The canonical stdlib-global name `expr` denotes, or null. Three
   * spellings reach the same global (Node's own aliasing):
   *   - the bare identifier (`process`), name + provenance checked;
   *   - the `global` identifier — Node's alias of globalThis — and
   *     `globalThis` itself both canonicalize to "globalThis";
   *   - a property read off globalThis (`globalThis.process`,
   *     `global.process`) — `declare var` globals ARE properties of
   *     `typeof globalThis`, same symbol either way;
   *   - a local alias binding (`const process = globalThis.process`, the
   *     tamper-guard prologue) registered in stdlibGlobalAliases. */
  export function stdlibGlobalNameOf(lowerer: Lowerer, expr: ts.Expression): string | null {
    if (ts.isParenthesizedExpression(expr)) return stdlibGlobalNameOf(lowerer, expr.expression);
    if (ts.isIdentifier(expr)) {
      // `globalThis` itself: a reserved intrinsic — tsc rejects user
      // bindings of the name, and its special symbol carries no ordinary
      // declarations for the provenance check to see.
      if (expr.text === "globalThis") return "globalThis";
      const symbol = lowerer.checker.getSymbolAtLocation(expr);
      if (!symbol) return null;
      const alias = lowerer.stdlibGlobalAliases.get(symbol);
      if (alias !== undefined) return alias;
      // An IMPORTED binding of a builtin module's re-exported global
      // (`import { Buffer } from "node:buffer"` — Node's module spelling
      // of the same object) resolves through the alias to the fallback
      // file's own export, so provenance and name check out exactly like
      // the bare-global spelling. A user module re-exporting its own
      // `Buffer` resolves to a user-file declaration and still misses.
      const resolved = symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
      if (!lowerer.isStdlibSymbol(resolved)) return null;
      return resolved.name === "global" ? "globalThis" : resolved.name;
    }
    if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
      if (stdlibGlobalNameOf(lowerer, expr.expression) !== "globalThis") return null;
      const symbol = lowerer.checker.getSymbolAtLocation(expr.name);
      if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
      return symbol.name === "global" ? "globalThis" : symbol.name;
    }
    return null;
  }

/** True iff `expr` denotes THE standard-library global `name` — name AND
   * provenance, because neither alone suffices: several globals share
   * member names (Math.log must never lower as console.log), and a user
   * binding shadowing a global's name has a different, non-stdlib symbol.
   * All of stdlibGlobalNameOf's spellings answer (globalThis.process is
   * process; `const process = globalThis.process` aliases through). */
  export function isStdlibGlobal(lowerer: Lowerer, expr: ts.Expression, name: string): boolean {
    return stdlibGlobalNameOf(lowerer, expr) === name;
  }

/** The member name of a `<global>.<member>` access whose receiver is THE
   * standard-library global `name` (console, JSON, process, Math). Null for
   * anything else, so property-lowering chains keep trying other
   * receivers. */
  export function stdlibGlobalMember(lowerer: Lowerer, access: ts.PropertyAccessExpression, name: string): string | null {
    if (access.questionDotToken) return null;
    return lowerer.isStdlibGlobal(access.expression, name) ? access.name.text : null;
  }

/** `const process = globalThis.process` (and any `const x = <stdlib
   * global>` snapshot — the suite harness's tamper-guard prologue): the
   * binding is pure alias plumbing. Nothing in a compiled program can
   * reassign a stdlib global, so the snapshot IS the global: the symbol
   * registers in stdlibGlobalAliases (every receiver check resolves
   * through it — see stdlibGlobalNameOf) and the declaration emits
   * nothing. Only the globals with lowered member surfaces alias this
   * way; aliasing, say, `Math` would change nothing (its members lower
   * by receiver too). Returns true when recognized. */
  export function stdlibGlobalAliasDecl(lowerer: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    if (!init || !ts.isIdentifier(nameNode)) return false;
    // `const process = require('node:process')`: Node's process MODULE is
    // the global process object (module.exports === globalThis.process),
    // so the binding aliases the global exactly like `const process =
    // globalThis.process`. Preflight admits exactly this shape
    // (processModuleAliasRequire7); commander's lib/command.js opens with
    // it.
    const requireSpec = requireSpecOf(init);
    const name =
      requireSpec === "process" || requireSpec === "node:process"
        ? "process"
        : stdlibGlobalNameOf(lowerer, init);
    if (name === null) return false;
    // Only alias OBJECT-shaped globals whose members lower by receiver
    // identity (process, console, globalThis itself, and perf_hooks'
    // performance — the mockable-clock idiom snapshots it). Function-valued
    // globals (setTimeout) taken as values are a different story — the
    // ordinary value paths (and their fences) apply.
    if (name !== "process" && name !== "console" && name !== "globalThis" && name !== "performance") return false;
    const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
    if (!symbol) return false;
    lowerer.stdlibGlobalAliases.set(symbol, name);
    return true;
  }

/** True iff the symbol is declared ONLY by the adopted @types/node
   * surface (no es-lib or shipped-ambient declaration merges in) — chooses
   * the SC2020 fence's wording: "typed by @types/node", not "standard
   * library". */
  export function nodeTypesOnlySymbol(lowerer: Lowerer, sym: ts.Symbol | null | undefined): boolean {
    const decls = sym ? lowerer.checker.declarationsOf(sym) : undefined;
    if (!decls || decls.length === 0) return false;
    let viaNode = false;
    for (const d of decls) {
      const sf = d.getSourceFile();
      if (sf.isDeclarationFile && isNodeTypesPath(sf.fileName)) viaNode = true;
      else if (lowerer.isStdlibFile(sf)) return false;
    }
    return viaNode;
  }
