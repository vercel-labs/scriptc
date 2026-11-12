import { keyedHelperName } from "../stable-names.js";
import { nodeThrowExpr, countedFor, strLit, varRef, dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  NULL_T,
  SEARCH_PARAMS_T,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  funcOf,
  isUnitType,
  typeKey,
} from "../../../ir/ir.js";
import { optionalStringTags } from "./arguments.js";
import { type BuiltinModuleFn } from "../surfaces.js";
import { lowerDynDispatchMethodCall } from "../lower-calls.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";

/** URL component assignment captures its receiver and RHS once, and yields
 * the original RHS after the setter performs string conversion. */
export function lowerUrlAssignment(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  let target = expr.left;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (
    (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ||
    target.questionDotToken
  )
    return null;
  const receiverType = lowerer.typeOf(target.expression);
  const native = lowerer.mapTypeOf(receiverType)?.kind === "url";
  if (!native && !(receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return null;
  const receiver = native
    ? lowerer.lowerExpr(target.expression)
    : tryLowerExpression(lowerer, target.expression);
  if (!receiver || receiver.type.kind !== "url") return null;
  const name = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : lowerer.foldedStringKeyOf(target.argumentExpression);
  const getters: Record<string, IrLibFn> = {
    href: "url.href",
    pathname: "url.pathname",
    search: "url.search",
    hash: "url.hash",
    protocol: "url.protocol",
    username: "url.username",
    password: "url.password",
    host: "url.host",
    hostname: "url.hostname",
    port: "url.port",
  };
  if (name === null || name === undefined || !Object.hasOwn(getters, name)) {
    lowerer.unsupported(
      "SC1090",
      target,
      "URL assignments to read-only members or runtime property keys",
    );
  }
  const op = expr.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsToken && op !== ts.SyntaxKind.PlusEqualsToken) {
    lowerer.unsupported("SC1090", expr, "URL setter assignment operators beyond = and +=");
  }
  const loc = locOf(expr);
  const recv = lowerer.declareHiddenLocal("%urlReceiver", receiver.type);
  const recvRef = varRef(recv.id, receiver.type, loc);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: recv.id, init: receiver, loc }];
  let prior: IrExpr | null = null;
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    const old = lowerer.declareHiddenLocal("%urlOld", STRING);
    const fn = getters[name]!;
    stmts.push({
      kind: "varDecl",
      localId: old.id,
      init: { kind: "libCall", fn, args: [recvRef], type: STRING, loc },
      loc,
    });
    prior = varRef(old.id, STRING, loc);
  }
  const raw = lowerer.lowerExpr(expr.right);
  if (
    prior &&
    raw.type.kind !== "string" &&
    raw.type.kind !== "f64" &&
    raw.type.kind !== "bool" &&
    raw.type.kind !== "bigint" &&
    !isUnitType(raw.type)
  ) {
    lowerer.unsupported(
      "SC1090",
      expr.right,
      "URL += operands requiring object-to-primitive conversion (assign an explicit string)",
    );
  }
  const value = lowerer.declareHiddenLocal("%urlValue", raw.type);
  stmts.push({ kind: "varDecl", localId: value.id, init: raw, loc });
  const valueRef = varRef(value.id, raw.type, loc);
  let result = valueRef;
  let assigned = valueRef;
  if (prior) {
    const text: IrExpr =
      raw.type.kind === "string"
        ? valueRef
        : {
            kind: "libCall",
            fn: "dyn.toStringCoerce",
            args: [lowerer.coerceInto(expr.right, valueRef, DYN)],
            type: STRING,
            loc,
          };
    const joined = lowerer.declareHiddenLocal("%urlJoined", STRING);
    stmts.push({
      kind: "varDecl",
      localId: joined.id,
      init: { kind: "strConcat", left: prior, right: text, type: STRING, loc },
      loc,
    });
    result = varRef(joined.id, STRING, loc);
    assigned = result;
  }
  const checked = !prior && raw.type.kind !== "string";
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: checked ? "url.setChecked" : "url.set",
      args: [
        recvRef,
        strLit(name, loc),
        checked ? lowerer.coerceInto(expr.right, valueRef, DYN) : assigned,
      ],
      type: VOID,
      loc,
    },
    loc,
  });
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** `url.Url` as a value: Node's legacy Url constructor. JavaScript sources
 * reach it the way parseurl does (`var Url = url.Url`); url.parse() results
 * are instances of it. One identity per thread. */
export function legacyUrlClassValue(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "url.legacyClass", args: [], type: DYN, loc };
}

/** Method calls on URL-typed receivers: `u.toString()` and `u.toJSON()` are Node's href
 * serialization (the href getter's libCall). Everything else the lib
 * declares fences member-qualified. Null for non-URL receivers. */
export function lowerUrlMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "url") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  if ((name === "toString" || name === "toJSON") && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "url.href", args: [receiver], type: STRING, loc: locOf(call) };
  }
  lowerer.noLowering(
    `URL.${name}`,
    call,
    "protocol, origin, username, password, pathname, href, host, hostname, port, search, hash, searchParams, toString(), and toJSON() are the supported URL members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** `new URLSearchParams(init?)` — the WHATWG constructor's lowered init
 * shapes: omitted / literal `undefined` (empty list), a string (parsed,
 * one leading '?' strips), another URLSearchParams (snapshot copy — a
 * `u.searchParams` argument included), a string[][] value (pairs;
 * Node's ERR_INVALID_TUPLE TypeError on a non-pair row, thrown by the
 * runtime), and an OBJECT LITERAL (each property appends in source
 * order — folded to a sp.with chain at compile time; keys are the
 * record-literal key forms, values coerce as strings). Tuple-typed pair
 * arrays and unions keep named fences. */
export function lowerSearchParamsNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 1) {
    lowerer.noLowering(
      `new URLSearchParams with ${args.length} arguments`,
      expr,
      "one init argument is the WHATWG surface",
    );
  }
  const arg = args[0];
  if (arg === undefined) {
    return { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc };
  }
  return lowerSearchParamsInit(lowerer, arg, loc);
}

/** The URLSearchParams built from one init expression. A conditional
 * init (`new URLSearchParams(c ? { a: "1" } : {})`) evaluates its
 * condition first and builds from the arm it selects, so each arm may be
 * any supported init shape. */

/** One record initializer's value: the expression as the literal evaluates
 * it in source order (`value`), and the conversion Node runs when the
 * constructor appends the entry (`coerce`, in Reflect.ownKeys order, which
 * `coerces` is false for when it is the identity: a typed string value is
 * already the entry). */
type ValueOf = { value: IrExpr; coerce: (raw: IrExpr) => IrExpr; coerces: boolean };

function lowerSearchParamsInit(lowerer: Lowerer, arg: ts.Expression, loc: SrcLoc): IrExpr {
  let inner = arg;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (ts.isConditionalExpression(inner)) {
    return {
      kind: "ternary",
      cond: lowerer.lowerCondition(inner.condition),
      then: lowerSearchParamsInit(lowerer, inner.whenTrue, loc),
      else_: lowerSearchParamsInit(lowerer, inner.whenFalse, loc),
      type: SEARCH_PARAMS_T,
      loc,
    };
  }
  if (ts.isIdentifier(arg) && arg.text === "undefined") {
    return { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc };
  }
  // The object-literal init: fold `{ a: "1", b: "2" }` into nested
  // sp.with calls over the empty list. The order is Node's
  // Reflect.ownKeys order for the literal rather than its source order:
  // its integer index keys ascending first, then the other string keys in
  // source order (`{ length: 2, 0: "a", 1: "b" }` answers
  // `0=a&1=b&length=2`). Only plain property assignments (tsc's
  // index-signature contextual type already rejects spreads' surprises,
  // but keep the fence tight).
  if (ts.isObjectLiteralExpression(arg)) {
    let acc: IrExpr = { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc };
    // Each value is a USVString. A typed value lowers into the string
    // slot. A JavaScript source's value may be untyped: it crosses into
    // the checked-dynamic tree and stringifies there, Node's ToString
    // (`{ a: "1", b: 2 }` answers `b=2`).
    const valueOf = (node: ts.Node, lower: () => IrExpr): ValueOf => {
      if (!isJsSourceFile(ts.getSourceFileOfNode(arg))) {
        const value = lowerer.lowerExprExpecting(node as ts.Expression, STRING);
        return { value, coerce: (raw) => raw, coerces: false };
      }
      const value = lower();
      if (value.type.kind === "string") return { value, coerce: (raw) => raw, coerces: false };
      if (!lowerer.dynConvertible(value.type)) {
        return { value, coerce: (raw) => lowerer.coerceInto(node, raw, STRING), coerces: true };
      }
      return {
        value,
        coerce: (raw) => ({
          kind: "libCall",
          fn: "dyn.toStringCoerce",
          args: [{ kind: "dynFrom", value: raw, type: DYN, loc: raw.loc }],
          type: STRING,
          loc: raw.loc,
        }),
        coerces: true,
      };
    };
    const pairs: { key: string; keyLoc: SrcLoc; value: ValueOf }[] = [];
    for (const prop of arg.properties.nodes) {
      // `{ model }` appends the binding's value under its own name, like
      // the `{ model: model }` spelling.
      if (ts.isShorthandPropertyAssignment(prop)) {
        const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
        pairs.push({
          key,
          keyLoc: locOf(prop.name),
          value: valueOf(prop.name, () => lowerer.lowerShorthandValue(prop)),
        });
        continue;
      }
      if (!ts.isPropertyAssignment(prop) || prop.name === undefined) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "URLSearchParams record inits with spreads or accessors",
        );
      }
      let key: string;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
        key = prop.name.text;
      } else if (ts.isNumericLiteral(prop.name)) {
        // A numeric literal names its property by ToString of the value
        // (`{ 1e3: v }` is `"1000"`, `{ 0o10: v }` is `"8"`).
        key = String(Number(prop.name.text));
      } else {
        lowerer.unsupported(
          "SC1090",
          prop.name,
          "non-literal keys in a URLSearchParams record init",
        );
      }
      pairs.push({
        key,
        keyLoc: locOf(prop.name),
        value: valueOf(prop.initializer, () => lowerer.lowerExpr(prop.initializer)),
      });
    }
    // Reflect.ownKeys order: the integer index keys ascending, then the
    // other string keys in source order. (tsc rejects a literal that names
    // one property twice, so every key here is distinct.)
    const isIndexKey = (key: string): boolean =>
      /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
    const indexed = pairs.map((pair, source) => ({ pair, source }));
    const ordered = [
      ...indexed
        .filter(({ pair }) => isIndexKey(pair.key))
        .sort((a, b) => Number(a.pair.key) - Number(b.pair.key)),
      ...indexed.filter(({ pair }) => !isIndexKey(pair.key)),
    ];
    // Node evaluates the literal's property initializers in SOURCE order
    // and only then iterates the record in Reflect.ownKeys order (the
    // constructor's conversion runs at append time). The initializers are
    // read into hidden locals first whenever that timing is observable:
    // when the two orders differ (`{ b: f(), 0: g() }`), so both their
    // effects and the values they answer come from the source order; and
    // when a value converts and a later initializer exists
    // (`{ a: converting(), b: tag() }` with the keys already in
    // enumeration order), so the conversion runs after every initializer
    // rather than between two of them. The chain below then appends in
    // Reflect order.
    let reads: IrExpr[] | null = null;
    if (
      ordered.some((entry, i) => entry.source !== i) ||
      pairs.some((pair, i) => pair.value.coerces && i + 1 < pairs.length)
    ) {
      const stmts: IrStmt[] = [];
      reads = pairs.map((pair) => {
        const local = lowerer.declareHiddenLocal("%spValue", pair.value.value.type);
        stmts.push({ kind: "varDecl", localId: local.id, init: pair.value.value, loc });
        return varRef(local.id, pair.value.value.type, loc);
      });
      acc = {
        kind: "seqExpr",
        stmts,
        result: acc,
        type: SEARCH_PARAMS_T,
        loc,
      };
    }
    for (const { pair, source } of ordered) {
      const raw = reads ? reads[source]! : pair.value.value;
      acc = {
        kind: "libCall",
        fn: "sp.with",
        args: [
          acc,
          { kind: "strLit", value: pair.key, type: STRING, loc: pair.keyLoc },
          pair.value.coerce(raw),
        ],
        type: SEARCH_PARAMS_T,
        loc,
      };
    }
    return acc;
  }
  const init = lowerer.lowerExpr(arg);
  if (init.type.kind === "dyn") {
    return { kind: "libCall", fn: "sp.newChecked", args: [init], type: SEARCH_PARAMS_T, loc };
  }
  if (init.type.kind === "string") {
    return { kind: "libCall", fn: "sp.parse", args: [init], type: SEARCH_PARAMS_T, loc };
  }
  const optionalString = lowerOptionalStringSearchParams(lowerer, init, loc);
  if (optionalString) return optionalString;
  if (init.type.kind === "searchParams") {
    // Node ITERATES the source list — the copy is a snapshot, not a
    // live alias (mutating the copy never touches the source or its
    // URL).
    return { kind: "libCall", fn: "sp.copy", args: [init], type: SEARCH_PARAMS_T, loc };
  }
  if (
    init.type.kind === "array" &&
    init.type.elem.kind === "array" &&
    init.type.elem.elem.kind === "string"
  ) {
    return { kind: "libCall", fn: "sp.fromPairs", args: [init], type: SEARCH_PARAMS_T, loc };
  }
  if (init.type.kind === "array" && init.type.elem.kind === "record") {
    const pairs = searchParamsFromTuples(lowerer, init, init.type.elem, loc);
    if (pairs) return pairs;
    lowerer.unsupported(
      "SC1090",
      arg,
      "URLSearchParams from tuple rows other than [string, string] (type the pairs as [string, string][] or string[][])",
    );
  }
  // A JavaScript source's init the static shapes do not name (a number or
  // other primitive, a pair array whose members are untyped): the
  // checked-dynamic constructor applies the WHATWG algorithm — iterate a
  // sequence, enumerate a record, else String(init).
  if (isJsSourceFile(ts.getSourceFileOfNode(arg)) && lowerer.dynConvertible(init.type)) {
    return {
      kind: "libCall",
      fn: "sp.newChecked",
      args: [{ kind: "dynFrom", value: init, type: DYN, loc: init.loc }],
      type: SEARCH_PARAMS_T,
      loc,
    };
  }
  lowerer.unsupported(
    "SC1090",
    arg,
    `URLSearchParams from '${lowerer.fmt(init.type)}' inits (a string, a string[][], another URLSearchParams, or an inline { key: value } literal — narrow unions first)`,
  );
}

/** `new URLSearchParams(pairs)` over a `[string, string][]` (an
 * Object.entries result, for example): a helper per tuple shape appends
 * each pair's name and value in array order. Null for other row types. */
function searchParamsFromTuples(
  lowerer: Lowerer,
  init: IrExpr,
  row: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr | null {
  const shape = lowerer.shapes.get(row.shapeId);
  if (
    !shape?.tuple ||
    shape.fields.length !== 2 ||
    !shape.fields.every(
      (field) => (field.name === "0" || field.name === "1") && field.type.kind === "string",
    )
  )
    return null;
  const key = `sp.fromTuples:${row.shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%sp.fromTuples", key);
    lowerer.valueHelpers.set(key, helper);
    const pairsT = init.type;
    const sp = (): IrExpr => varRef("sp.0", SEARCH_PARAMS_T, loc);
    const pair = (): IrExpr => varRef("pair.0", row, loc);
    const field = (name: "0" | "1"): IrExpr => ({
      kind: "recordGet",
      obj: pair(),
      shapeId: row.shapeId,
      field: name,
      type: STRING,
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "sp.0",
        init: { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc },
        loc,
      },
      countedFor(
        loc,
        {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef("pairs.0", pairsT, loc),
          args: [],
          type: F64,
          loc,
        },
        (index) => [
          {
            kind: "varDecl",
            localId: "pair.0",
            init: { kind: "arrayGet", arr: varRef("pairs.0", pairsT, loc), index, type: row, loc },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "sp.append",
              args: [sp(), field("0"), field("1")],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
      ),
      { kind: "return", value: sp(), loc },
    ];
    const fn: IrFunction = {
      name: helper,
      params: [{ localId: "pairs.0", name: "pairs", type: pairsT }],
      returnType: SEARCH_PARAMS_T,
      locals: [
        { id: "pairs.0", name: "pairs", type: pairsT, mutable: false },
        { id: "sp.0", name: "sp", type: SEARCH_PARAMS_T, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "pair.0", name: "pair", type: row, mutable: false },
      ],
      body,
      loc,
    };
    lowerer.liftedFns.push(fn);
  }
  return { kind: "call", callee: helper, args: [init], type: SEARCH_PARAMS_T, loc };
}

function lowerOptionalStringSearchParams(
  lowerer: Lowerer,
  init: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const tags = optionalStringTags(lowerer, init.type);
  if (!tags || init.type.kind !== "union") return null;
  const key = `sp.optionalString:${init.type.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%sp.optionalString", key);
    lowerer.valueHelpers.set(key, helper);
    const value = varRef("init.0", init.type, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "init.0", name: "init", type: init.type }],
      returnType: SEARCH_PARAMS_T,
      locals: [{ id: "init.0", name: "init", type: init.type, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: init.type.unionId,
            tag: tags.undefinedTag,
            negated: false,
            value,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "return",
              value: { kind: "libCall", fn: "sp.new", args: [], type: SEARCH_PARAMS_T, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "sp.parse",
            args: [
              {
                kind: "unionNarrow",
                unionId: init.type.unionId,
                tag: tags.stringTag,
                value,
                type: STRING,
                loc,
              },
            ],
            type: SEARCH_PARAMS_T,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [init], type: SEARCH_PARAMS_T, loc };
}

/** Method calls on URLSearchParams-typed receivers — the WHATWG list
 * surface over the runtime's decoded pairs. get answers `string | null`
 * (the checker's own union; the runtime's +1-or-NULL builds the arms);
 * has/delete take the value-aware second argument (an explicitly
 * `undefined`-typed second argument means the name-only form, Node's
 * treatment); forEach desugars to a synthesized index loop over the
 * LIVE list (sp.size re-reads every pass — appends mid-walk are
 * visited, deletes shift, the spec's index-based iteration).
 * keys()/values()/entries() lower only in a for-of head (lower-stmts
 * routes them before this table) — stored iterator objects keep the
 * drain fence. Null for non-searchParams receivers. */
export function lowerSearchParamsMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "searchParams") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  // The WHATWG arity ladder: too few arguments throw Node's
  // ERR_MISSING_ARGS before any conversion (the invalid-input probes'
  // `params.get()`). Node evaluates the receiver and the present
  // arguments first, then throws, so every supplied expression's effects
  // are kept (`make().append(name())` calls `name()`) and only the missing
  // slot is not converted.
  const required: Record<string, [number, string] | undefined> = {
    get: [1, 'The "name" argument must be specified'],
    getAll: [1, 'The "name" argument must be specified'],
    has: [1, 'The "name" argument must be specified'],
    delete: [1, 'The "name" argument must be specified'],
    append: [2, 'The "name" and "value" arguments must be specified'],
    set: [2, 'The "name" and "value" arguments must be specified'],
  };
  const req = own(required, name);
  if (req && args.length < req[0]) {
    const thrown = nodeThrowExpr(
      1,
      "ERR_MISSING_ARGS",
      req[1],
      lowerer.mapTypeOf(lowerer.typeOf(call)) ?? VOID,
      loc,
    );
    const stmts: IrStmt[] = [];
    const receiver = lowerer.lowerExpr(access.expression);
    if (!isSafeToDiscard(receiver)) {
      stmts.push({ kind: "exprStmt", expr: receiver, loc: receiver.loc });
    }
    for (const arg of args) {
      const value = lowerer.lowerExpr(arg);
      if (!isSafeToDiscard(value)) stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
    }
    if (stmts.length === 0) return thrown;
    return {
      kind: "seqExpr",
      stmts,
      result: thrown,
      type: thrown.type,
      loc,
    };
  }
  // One name/value slot, WHATWG USVString rules: statically-string
  // arguments lower directly; a symbol can never convert (V8's
  // TypeError, statically decided); everything else crosses into the
  // dyn and coerces at runtime with the object protocol (a user
  // toString/valueOf runs and its throw propagates).
  const strArg = (i: number): IrExpr => {
    const node = args[i]!;
    const t = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (t?.kind === "string") return lowerer.lowerExprExpecting(node, STRING);
    if (t?.kind === "symbol") {
      return nodeThrowExpr(1, "", "Cannot convert a Symbol value to a string", STRING, loc);
    }
    let v: IrExpr;
    if (ts.isObjectLiteralExpression(node)) {
      // Object literals take the dyn literal path directly (method
      // members box as dyn functions — the typed record fence never
      // applies to the coercion probes).
      v = lowerDynObjectLiteral(lowerer, node);
    } else {
      const raw = lowerer.lowerExpr(node);
      if (raw.type.kind === "dyn") v = raw;
      else if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
        v = { kind: "dynFrom", value: raw, type: DYN, loc: raw.loc };
      } else if (raw.type.kind === "record") {
        // A RECORD-represented value that cannot cross into the checked-dynamic tree (a
        // func-carrying shape — the throwing-toString probes): run
        // ToPrimitive's string hint STATICALLY. A zero-parameter
        // toString func member is called (its throw propagates); a
        // string answer is the conversion, and a void/never-typed one
        // (the always-throwing probe shape, or a bare undefined return)
        // stringifies as ToString(undefined). Other shapes keep the
        // fence — honesty over coverage.
        const shape = lowerer.shapes.get(raw.type.shapeId);
        const tsMember = shape?.fields.find((f) => f.name === "toString");
        if (
          shape &&
          tsMember &&
          tsMember.type.kind === "func" &&
          tsMember.type.params.length === 0 &&
          lowerer.dynConvertible(tsMember.type)
        ) {
          // Box just the toString member into a fresh dyn carrier and
          // run the protocol at runtime — the boxed call propagates its
          // throw, string answers convert, and a bare (void) return is
          // ToString(undefined), all through one path.
          const member: IrExpr = {
            kind: "recordGet",
            obj: raw,
            shapeId: raw.type.shapeId,
            field: "toString",
            type: tsMember.type,
            loc,
          };
          v = {
            kind: "dynObjLit",
            fields: [
              {
                key: { kind: "strLit", value: "toString", type: STRING, loc },
                value: { kind: "dynFrom", value: member, type: DYN, loc },
              },
            ],
            type: DYN,
            loc,
          };
        } else {
          lowerer.noLowering(
            `URLSearchParams.${name} with a '${lowerer.fmt(raw.type)}' argument`,
            node,
            "string arguments are the lowered shape (other values coerce through the checked-dynamic tree — narrow unions first)",
          );
        }
      } else {
        lowerer.noLowering(
          `URLSearchParams.${name} with a '${lowerer.fmt(raw.type)}' argument`,
          node,
          "string arguments are the lowered shape (other values coerce through the checked-dynamic tree — narrow unions first)",
        );
      }
    }
    return { kind: "libCall", fn: "dyn.toStringCoerce", args: [v], type: STRING, loc };
  };
  // has/delete's OPTIONAL value argument: absent, or an explicitly
  // undefined-typed expression (Node treats explicit undefined as the
  // name-only form). A `string | undefined` union has two behaviors in
  // one value — narrow first.
  const optionalValueArg = (): IrExpr | null => {
    if (args.length === 1) return null;
    const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
    if (t?.kind === "undefinedT") return null;
    if (t?.kind === "string") return strArg(1);
    lowerer.unsupported(
      "SC1090",
      args[1]!,
      `URLSearchParams.${name} with a '${lowerer.checker.typeToString(lowerer.typeOf(args[1]!))}' value argument (pass a string, or narrow '| undefined' unions to the two call forms first)`,
    );
  };
  if (name === "get" && args.length === 1) {
    const receiver = lowerer.lowerExpr(access.expression);
    const type: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, NULL_T]) };
    return { kind: "libCall", fn: "sp.get", args: [receiver, strArg(0)], type, loc };
  }
  if (name === "getAll" && args.length === 1) {
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: "sp.getAll",
      args: [receiver, strArg(0)],
      type: arrayOf(STRING),
      loc,
    };
  }
  if ((name === "append" || name === "set") && args.length === 2) {
    const receiver = lowerer.lowerExpr(access.expression);
    const fn = name === "append" ? "sp.append" : "sp.set";
    return { kind: "libCall", fn, args: [receiver, strArg(0), strArg(1)], type: VOID, loc };
  }
  if (name === "delete" && (args.length === 1 || args.length === 2)) {
    const receiver = lowerer.lowerExpr(access.expression);
    const nameArg = strArg(0);
    const value = optionalValueArg();
    return value === null
      ? { kind: "libCall", fn: "sp.delete", args: [receiver, nameArg], type: VOID, loc }
      : {
          kind: "libCall",
          fn: "sp.deleteValue",
          args: [receiver, nameArg, value],
          type: VOID,
          loc,
        };
  }
  if (name === "has" && (args.length === 1 || args.length === 2)) {
    const receiver = lowerer.lowerExpr(access.expression);
    const nameArg = strArg(0);
    const value = optionalValueArg();
    return value === null
      ? { kind: "libCall", fn: "sp.has", args: [receiver, nameArg], type: BOOL, loc }
      : { kind: "libCall", fn: "sp.hasValue", args: [receiver, nameArg, value], type: BOOL, loc };
  }
  if (name === "sort" && args.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "sp.sort", args: [receiver], type: VOID, loc };
  }
  if (name === "toString" && args.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "sp.toString", args: [receiver], type: STRING, loc };
  }
  if (name === "forEach" && args.length <= 2) {
    const callback = args[0];
    const callbackType = callback ? lowerer.mapTypeOf(lowerer.typeOf(callback)) : undefined;
    // A callable of the lowered slots unrolls the index walk statically.
    // Every other shape — a JavaScript source's missing or non-function
    // argument — takes the native handle's forEach, which applies Node's
    // ERR_INVALID_ARG_TYPE gate at the point the call runs.
    if (callbackType?.kind === "func" && spForEachSlotFits(callbackType.params))
      return lowerSpForEachCall(lowerer, call, access);
    const boxed = lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN);
    const dyn = lowerDynDispatchMethodCall(lowerer, call, access, boxed, false);
    if (dyn) return dyn;
  }
  if ((name === "keys" || name === "values" || name === "entries") && args.length === 0) {
    // Outside a for-of head the iterator is a live object: the checked-
    // dynamic view's iterator walks the pair list by index
    // (scr_native_sp_step), so entries appended after it was created are
    // visited, as in Node.
    const boxed = lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN);
    const iterator = lowerDynDispatchMethodCall(lowerer, call, access, boxed, false);
    if (iterator) return iterator;
  }
  // A JavaScript source's surplus arguments: WebIDL ignores them after
  // evaluating them, so the native handle's method reads the slots it
  // needs and drops the rest (`params.get("a", "b")` answers `get("a")`).
  if (
    (name === "get" ||
      name === "getAll" ||
      name === "has" ||
      name === "delete" ||
      name === "append" ||
      name === "set" ||
      name === "sort" ||
      name === "toString") &&
    isJsSourceFile(ts.getSourceFileOfNode(call))
  ) {
    const boxed = lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN);
    const dyn = lowerDynDispatchMethodCall(lowerer, call, access, boxed, false);
    if (dyn) return dyn;
  }
  lowerer.noLowering(
    `URLSearchParams.${name}`,
    call,
    "get, getAll, set, append, delete, has, sort, size, toString(), forEach, and for-of iteration are the supported URLSearchParams members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** A forEach callback whose parameters the static index walk can fill: the
 * value and name slots are strings, the third is the list itself, and a
 * parameter the checker leaves untyped (a JavaScript source's callback, or
 * an `any`/`unknown` spelling) lowers as the checked-dynamic value. */
function spForEachSlotFits(params: readonly IrType[]): boolean {
  if (params.length > 3) return false;
  return params.every((type, index) =>
    index < 2
      ? type.kind === "string" || type.kind === "dyn"
      : type.kind === "searchParams" || type.kind === "dyn",
  );
}

/** `sp.forEach(fn)` — a synthesized module function per callback arity
 * (interned), whose body is the LIVE index walk:
 *
 *   for (i = 0; i < sp.size; i++) { v = sp.valAt(i); k = sp.keyAt(i); f(v, k, sp?); }
 *
 * sp.size re-reads every pass — the spec's index-based iteration (Map's
 * forEach precedent, minus the tombstone machinery the pair list
 * doesn't need: deletes compact immediately). The callback receives
 * (value, name, searchParams) like the WHATWG signature; declaring
 * fewer parameters is ordinary TS. */
function lowerSpForEachCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments.nodes[0]!;
  const fnArg = lowerer.lowerExpr(argNode);
  if (fnArg.type.kind !== "func" || !spForEachSlotFits(fnArg.type.params)) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const receiver = lowerer.lowerExpr(access.expression);
  const arity = fnArg.type.params.length;
  const fnRet = fnArg.type.ret;
  // The optional second argument is the callback's `this` (the WHATWG
  // signature's thisArg), passed through the same dynamic slot the
  // collection forEach helpers use.
  const thisArgNode = call.arguments.nodes[1];
  const thisArg = thisArgNode === undefined ? null : lowerer.lowerExprExpecting(thisArgNode, DYN);
  // The helper's own parameter list is the callback's (string slots stay
  // static, untyped ones cross as the checked-dynamic value), so the
  // interned key spells it too.
  const paramKinds = fnArg.type.params.map((type) => type.kind).join(",");
  const key = `${arity}:${paramKinds}:${typeKey(fnRet)}${thisArg ? ":this" : ""}`;
  let helper = lowerer.spHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%sp.forEach", key);
    lowerer.spHofHelpers.set(key, helper);
    lowerer.liftedFns.push(
      buildSpForEachFn(helper, fnArg.type.params, fnRet, loc, thisArg !== null),
    );
  }
  return {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg, ...(thisArg ? [thisArg] : [])],
    type: VOID,
    loc,
  };
}

/** The Sp.forEach helper's body (see lowerSpForEachCall). `paramTypes` is
 * the callback's own parameter list: a string slot takes the walked value
 * directly, and a checked-dynamic slot (an untyped or `any` callback
 * parameter) takes the same value boxed. */
function buildSpForEachFn(
  name: string,
  paramTypes: readonly IrType[],
  fnRet: IrType,
  loc: SrcLoc,
  withThis = false,
): IrFunction {
  const arity = paramTypes.length;
  const fnT = funcOf([...paramTypes], fnRet);
  const sp = (fn: "sp.size" | "sp.keyAt" | "sp.valAt", extra: IrExpr[], type: IrType): IrExpr => ({
    kind: "libCall",
    fn,
    args: [varRef("sp.0", SEARCH_PARAMS_T, loc), ...extra],
    type,
    loc,
  });
  const locals: IrLocal[] = [
    { id: "sp.0", name: "sp", type: SEARCH_PARAMS_T, mutable: false },
    { id: "f.0", name: "f", type: fnT, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
  ];
  const callArgs: IrExpr[] = [];
  const body: IrStmt[] = [];
  const intoSlot = (value: IrExpr, slot: IrType): IrExpr =>
    slot.kind === "dyn" ? { kind: "dynFrom", value, type: DYN, loc } : value;
  if (arity >= 1) {
    locals.push({ id: "v.0", name: "v", type: STRING, mutable: false });
    body.push({
      kind: "varDecl",
      localId: "v.0",
      init: sp("sp.valAt", [varRef("i.0", F64, loc)], STRING),
      loc,
    });
    callArgs.push(intoSlot(varRef("v.0", STRING, loc), paramTypes[0]!));
  }
  if (arity >= 2) {
    locals.push({ id: "k.0", name: "k", type: STRING, mutable: false });
    body.push({
      kind: "varDecl",
      localId: "k.0",
      init: sp("sp.keyAt", [varRef("i.0", F64, loc)], STRING),
      loc,
    });
    callArgs.push(intoSlot(varRef("k.0", STRING, loc), paramTypes[1]!));
  }
  if (arity === 3) callArgs.push(intoSlot(varRef("sp.0", SEARCH_PARAMS_T, loc), paramTypes[2]!));
  body.push({
    kind: "exprStmt",
    expr: {
      kind: "callValue",
      callee: varRef("f.0", fnT, loc),
      args: callArgs,
      ...(withThis ? { receiver: varRef("t.0", DYN, loc) as IrExpr } : {}),
      type: fnRet,
      loc,
    },
    loc,
  });
  const loop = countedFor(loc, sp("sp.size", [], F64), () => body);
  const params: IrParam[] = [
    { localId: "sp.0", name: "sp", type: SEARCH_PARAMS_T },
    { localId: "f.0", name: "f", type: fnT },
  ];
  if (withThis) {
    locals.push({ id: "t.0", name: "t", type: DYN, mutable: false });
    params.push({ localId: "t.0", name: "t", type: DYN });
  }
  return {
    name,
    params,
    returnType: VOID,
    locals,
    body: [loop],
    loc,
  };
}

export function lowerFileUrlCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
  hasSpread: boolean,
): IrExpr {
  if (hasSpread || expr.arguments.nodes.length > 2) {
    lowerer.noLowering(
      `${bi.member} with these arguments`,
      expr,
      "pass a path and optional options object directly",
    );
  }
  // Keep the established typed one-argument paths free of boxing. The
  // checked variants preserve each converter's validation/getter order.
  if (expr.arguments.nodes.length === 1 && bi.member !== "fileURLToPathBuffer") {
    const arg = lowerer.lowerExpr(expr.arguments.nodes[0]!);
    if (bi.member === "fileURLToPath") {
      if (arg.type.kind === "url")
        return { kind: "libCall", fn: "url.fileURLToPathUrl", args: [arg], type: STRING, loc };
      if (arg.type.kind === "string")
        return { kind: "libCall", fn: "url.fileURLToPathStr", args: [arg], type: STRING, loc };
    } else if (arg.type.kind === "string") {
      return {
        kind: "libCall",
        fn: lowerer.targetPlatform === "win32" ? "url.pathToFileURLWin32" : "url.pathToFileURL",
        args: [arg],
        type: fn.result,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: fn.fn,
      args: [lowerer.coerceToExpected(arg, DYN), dynUndefinedExpr(loc)],
      type: fn.result,
      loc,
    };
  }
  const args = [0, 1].map((index) =>
    expr.arguments.nodes[index]
      ? lowerer.lowerExprExpecting(expr.arguments.nodes[index]!, DYN)
      : dynUndefinedExpr(loc),
  );
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}

/** Node's isInsideNodeModules test on the calling file: url.parse()'s
 * DEP0169 warning skips calls made from dependencies. */
function insideNodeModules(file: string): boolean {
  return /[/\\]node_modules[/\\]/.test(file);
}

/** node:url's legacy API and the domain pair. Every argument crosses as a
 * checked-dynamic value so the runtime applies Node's own validation
 * (validateString, the urlObject type ladder, String() for the domain);
 * parse/format/resolve also carry whether this call site emits DEP0169. */
export function lowerLegacyUrlCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
): IrExpr {
  const arity =
    bi.member === "parse" ? 3 : bi.member === "format" || bi.member === "resolve" ? 2 : 1;
  if (expr.arguments.nodes.some(ts.isSpreadElement) || expr.arguments.nodes.length > arity) {
    lowerer.noLowering(
      `url.${bi.member} with these arguments`,
      expr,
      `pass at most ${arity} argument${arity === 1 ? "" : "s"} directly`,
    );
  }
  const args: IrExpr[] = [];
  for (let index = 0; index < arity; index++) {
    let arg = expr.arguments.nodes[index];
    while (arg && ts.isParenthesizedExpression(arg)) arg = arg.expression;
    // An inline urlObject or options literal builds as the checked-dynamic
    // object format() reads (nested query objects included).
    args.push(
      !arg
        ? dynUndefinedExpr(loc)
        : ts.isObjectLiteralExpression(arg)
          ? lowerDynObjectLiteral(lowerer, arg)
          : lowerer.lowerExprExpecting(arg, DYN),
    );
  }
  if (bi.member === "domainToASCII" || bi.member === "domainToUnicode") {
    args.push({ kind: "boolLit", value: expr.arguments.nodes.length === 0, type: BOOL, loc });
  } else {
    const warn = !insideNodeModules(ts.getSourceFileOfNode(expr).fileName);
    args.push({ kind: "boolLit", value: warn, type: BOOL, loc });
  }
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}

/** A URLSearchParams value, or a keys()/values()/entries() call on one: an
 * iterable whose checked-dynamic view walks the live pair list. */
export function isSearchParamsIterable(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "searchParams") return true;
  if (
    !ts.isCallExpression(node) ||
    node.arguments.nodes.length !== 0 ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  const name = node.expression.name.text;
  return (
    (name === "keys" || name === "values" || name === "entries") &&
    lowerer.mapTypeOf(lowerer.typeOf(node.expression.expression))?.kind === "searchParams"
  );
}
