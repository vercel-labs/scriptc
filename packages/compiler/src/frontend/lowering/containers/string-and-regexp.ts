import * as ts from "../../ts7/adapter.js";
import { BOOL, F64, IrExpr, IrFunction, IrStmt, IrType, STRING, SrcLoc, arrayOf, isUnitType, typeEquals, typeKey } from "../../../ir/ir.js";
import { numLit, strLit, varRef } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { nodeThrowExpr, own } from "../lowerer.js";
import { isRequireMainFilename } from "../expressions/optional-chains.js";
import { STR_METHODS } from "../surfaces.js";
import { coerceStringSearchValue, defaultAfterUndefined, lowerOptionalArgument, lowerPositionArgument, lowerStaticallyUndefinedArgument, lowerStringSearchArgument, positionNumber } from "../optional-arguments.js";

function lowerSplitLimitArg(lowerer: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  const defaultValue: IrExpr = { kind: "numLit", value: 4294967295, type: F64, loc };
  return node ? lowerOptionalArgument(lowerer, node, F64, defaultValue) : defaultValue;
}

function lowerRegexSubject(lowerer: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  const absent: IrExpr = { kind: "strLit", value: "undefined", type: STRING, loc };
  if (!node) return absent;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, absent);
  const value = lowerer.lowerExpr(node);
  if (value.kind === "unitLit") return { kind: "strLit", value: value.unit, type: STRING, loc };
  return lowerer.ensureString(value, node);
}

/** Extract the checker-proven receiver arm from a runtime-optional property
 * read. The receiver is stabilized once before its tag is tested, and a
 * missing value throws the same property-read TypeError Node throws before
 * evaluating method arguments. */
function lowerMethodReceiver(
  lowerer: Lowerer,
  node: ts.Expression,
  expected: IrType,
  member: string,
): IrExpr {
  const lowered = lowerer.lowerExpr(node);
  const optional = lowerer.runtimeOptionalPropertyReceiver(node, lowered, expected, member);
  if (optional) return optional;
  if (typeEquals(lowered.type, expected)) return lowered;
  return lowerer.coerceInto(node, lowered, expected);
}

function paddingFillString(lowerer: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  const loc = value.loc;
  if (value.type.kind === "undefinedT" || value.type.kind === "void") return strLit(" ", loc);
  if (value.type.kind === "nullT") return strLit("null", loc);
  if (value.type.kind === "dyn") {
    return {
      kind: "ternary",
      cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
      then: strLit(" ", loc),
      else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [value], type: STRING, loc },
      type: STRING, loc,
    };
  }
  if (value.type.kind === "union") {
    const unionId = value.type.unionId;
    const arms = lowerer.unions.get(unionId)!.arms;
    let result: IrExpr = strLit(" ", loc);
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arms[tag]!, loc };
      const converted = paddingFillString(lowerer, narrowed, node);
      result = tag === arms.length - 1 ? converted : {
        kind: "ternary",
        cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
        then: converted, else_: result, type: STRING, loc,
      };
    }
    return result;
  }
  return lowerer.ensureString(value, node);
}

/** Pad arguments are evaluated before receiver/length coercion, while fill
 * conversion runs only if padding is needed. One helper keeps that order for
 * member calls and direct String.prototype calls alike. */
export function lowerStringPaddingCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "padStart" | "padEnd",
  receiver: IrExpr,
  receiverNode: ts.Node,
  argumentNodes: readonly ts.Expression[],
): IrExpr {
  if (argumentNodes.length > 2) {
    return lowerer.noLowering(`.${method} with ${argumentNodes.length} arguments`, call);
  }
  const loc = locOf(call);
  const maxLength = lowerPositionArgument(lowerer, argumentNodes[0], numLit(0, loc));
  const fillNode = argumentNodes[1];
  const undefinedFill = fillNode ? lowerStaticallyUndefinedArgument(lowerer, fillNode) : null;
  const rawFill = !fillNode ? strLit(" ", loc) : undefinedFill
    ? defaultAfterUndefined(undefinedFill, strLit(" ", loc))
    : lowerer.lowerExpr(fillNode);
  const fill = rawFill.type.kind === "nullT"
    ? defaultAfterUndefined(rawFill, strLit("null", loc)) : rawFill;
  const values = [receiver, maxLength, fill];
  const key = `str.pad:${method}:${values.map(value => typeKey(value.type)).join(":")}`;
  let helper = lowerer.widthHelpers.get(key);
  if (!helper) {
    helper = `%str.pad.${lowerer.widthHelpers.size}`;
    const params = values.map((value, index) => ({ localId: `arg.${index}`, name: `arg${index}`, type: value.type }));
    const rawReceiver = varRef("arg.0", receiver.type, loc);
    const convertedReceiver: IrExpr = receiver.type.kind === "dyn" ? {
      kind: "ternary",
      cond: { kind: "dynTest", test: "nullish", value: rawReceiver, type: BOOL, loc },
      then: nodeThrowExpr(1, "", `String.prototype.${method} called on null or undefined`, STRING, loc),
      else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [rawReceiver], type: STRING, loc },
      type: STRING, loc,
    } : lowerer.ensureString(rawReceiver, receiverNode);
    const stringReceiver = varRef("receiver.0", STRING, loc);
    const length = varRef("length.0", F64, loc);
    const fillValue = varRef("arg.2", fill.type, loc);
    const padded: IrExpr = {
      kind: "strIntrinsic", method, receiver: stringReceiver,
      args: [length, paddingFillString(lowerer, fillValue, fillNode ?? call)], type: STRING, loc,
    };
    const result: IrExpr = {
      kind: "ternary",
      cond: {
        kind: "bin", op: ">=", left: length,
        right: {
          kind: "bin", op: "+",
          left: { kind: "strIntrinsic", method: "length", receiver: stringReceiver, args: [], type: F64, loc },
          right: numLit(1, loc), type: F64, loc,
        },
        type: BOOL, loc,
      },
      then: padded, else_: stringReceiver, type: STRING, loc,
    };
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "receiver.0", init: convertedReceiver, loc },
      { kind: "varDecl", localId: "length.0", init: positionNumber(lowerer, varRef("arg.1", maxLength.type, loc), numLit(0, loc), argumentNodes[0] ?? call, "string padding length"), loc },
      { kind: "return", value: result, loc },
    ];
    lowerer.widthHelpers.set(key, helper);
    lowerer.liftedFns.push({
      name: helper, params, returnType: STRING,
      locals: [
        ...params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
        { id: "receiver.0", name: "receiver", type: STRING, mutable: false },
        { id: "length.0", name: "length", type: F64, mutable: false },
      ],
      body, loc,
    });
  }
  return { kind: "call", callee: helper, args: values, type: STRING, loc };
}

/** Regex method calls, both directions: `re.test(s)` on a regex receiver,
 * and `s.replace(re, tpl)` / `s.replaceAll(re, tpl)` / `s.split(re)` on a
 * string receiver whose FIRST ARGUMENT is a regex (the string-pattern
 * overloads keep their island lowering — the argument's mapped type is
 * what routes here, before lowerIslandMethodCall can claim the name).
 * Null when neither shape matches. */
export function lowerRegexMethodCall(lowerer: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  dynReceiver?: () => IrExpr,): IrExpr | null {
  // chainBlocked, not a raw token test: an optional-chain re-dispatch
  // (`rawName?.match(re)` — the receiver reads back chain-narrowed)
  // rides the same lowering as the plain spelling.
  if (lowerer.chainBlocked(access, call)) return null;
  // A validated dyn receiver (lowerStringMethodCall's story) is a STRING
  // by construction — the symbol gate doesn't apply to `any` receivers.
  if (dynReceiver === undefined && !lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const receiverKind = dynReceiver ? "string" : lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind;
  const lowerReceiver = (): IrExpr => {
    if (dynReceiver) return dynReceiver();
    if (receiverKind === "string") return lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
    if (receiverKind === "regex") return lowerMethodReceiver(lowerer, access.expression, { kind: "regex" }, access.name.text);
    return lowerer.lowerExpr(access.expression);
  };
  const loc = locOf(call);
  if (receiverKind === "regex" && name === "test") {
    if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering("RegExp.prototype.test with surplus or spread arguments", call);
    }
    // The statefulness fence, at compile time where the flags are
    // visible: a literal receiver (possibly parenthesized). Values that
    // flow through variables hit the same fence at runtime.
    let recv: ts.Expression = access.expression;
    while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
    if (ts.isRegularExpressionLiteral(recv)) {
      const flags = recv.text.slice(recv.text.lastIndexOf("/") + 1);
      if (flags.includes("g") || flags.includes("y")) {
        lowerer.unsupported("SC1121", call);
      }
    }
    const receiver = lowerReceiver();
    const args = [lowerRegexSubject(lowerer, call.arguments[0], loc)];
    return { kind: "regexIntrinsic", method: "test", receiver, args, type: BOOL, loc };
  }
  // `re.exec(s)` for non-g/y regexes: spec-identical to `s.match(re)`
  // (Symbol.match delegates to exec when lastIndex is out of play), so
  // it lowers to the SAME match intrinsic with the operands swapped —
  // the honest `string[] | null` slice, nonparticipating captures ""
  // (match's documented rule). The g/y statefulness fence applies at
  // compile time on literal receivers, exactly test()'s stance; values
  // reaching the runtime with those flags abort there.
  if (receiverKind === "regex" && name === "exec") {
    if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) return null;
    let recv: ts.Expression = access.expression;
    while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
    if (ts.isRegularExpressionLiteral(recv)) {
      const flags = recv.text.slice(recv.text.lastIndexOf("/") + 1);
      if (flags.includes("g") || flags.includes("y")) {
        lowerer.unsupported("SC1121", call);
      }
    }
    const re = lowerReceiver();
    const subject = lowerRegexSubject(lowerer, call.arguments[0], loc);
    const resultT: IrType = { kind: "union", unionId: lowerer.unions.intern([arrayOf(STRING), { kind: "nullT" }]) };
    // The shared match intrinsic takes the string first; preserve exec's
    // receiver-before-subject evaluation order before swapping operands.
    const saved = lowerer.declareHiddenLocal("%execReceiver", re.type);
    const result: IrExpr = { kind: "regexIntrinsic", method: "match", receiver: subject, args: [varRef(saved.id, re.type, loc)], type: resultT, loc };
    return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: saved.id, init: re, loc }], result, type: resultT, loc };
  }
  // `s.match(re)` for non-g/y regexes: Node's exec-shaped result reduced
  // to the honest slice — the `string[] | null` union holding
  // [whole match, ...captures] or the null arm. The g-flag match returns
  // EVERY match (a different shape) and /y is stateful — both fence at
  // compile time on literal arguments (values reaching the runtime with
  // those flags abort, the test() stance). `.index`/`.input` reads on
  // the result fence per member (array-typed value); `.groups` reads
  // desugar at their access sites when the regex is statically known
  // (lowerMatchGroupsRead).
  // `s.match(re)` also claims a NULLABLE string receiver (string + unit
  // arms — `process.versions.openssl.match(...)`, the Dict<string>
  // member the node suite's crypto helper reads): the checked
  // extraction narrows to the string arm and a unit value throws the
  // catchable TypeError at the read, where Node's own member read
  // throws — tsc only admits the spelling in JS sources.
  const nullableStringRecv =
    receiverKind === "union" &&
    name === "match" &&
    (() => {
      const t = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
      if (t?.kind !== "union") return false;
      const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
      return arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a));
    })();
  if ((receiverKind === "string" || nullableStringRecv) && name === "match") {
    const arg0 = call.arguments[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null; // string-pattern match: the SC2020 fence
    if (call.arguments.length !== 1) return null;
    let reNode: ts.Expression = arg0;
    while (ts.isParenthesizedExpression(reNode)) reNode = reNode.expression;
    if (ts.isRegularExpressionLiteral(reNode)) {
      const flags = reNode.text.slice(reNode.text.lastIndexOf("/") + 1);
      if (flags.includes("g") || flags.includes("y")) {
        lowerer.unsupported(
          "SC1120",
          call,
          "'.match()' with the 'g' or 'y' flag (an every-match array is a different shape — use replaceAll/split, or test() per position)",
        );
      }
    }
    const receiver = nullableStringRecv
      ? lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text)
      : lowerReceiver();
    const re = lowerer.lowerExpr(arg0);
    // RegExpMatchArray | null maps to the string[] | null union by
    // itself; intern it directly when the checker's spelling doesn't —
    // or when it maps to something WIDER (an optional-chain call node
    // types `s?.match(re)` with the chain's `| undefined`; the intrinsic
    // itself answers string[] | null, and the chain wrapper widens).
    const exactT: IrType = { kind: "union", unionId: lowerer.unions.intern([arrayOf(STRING), { kind: "nullT" }]) };
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
    const resultT: IrType = mapped && typeEquals(mapped, exactT) ? mapped : exactT;
    return { kind: "regexIntrinsic", method: "match", receiver, args: [re], type: resultT, loc };
  }
  // `s.matchAll(re)` — the every-match iterator drained EAGERLY into a
  // string[][] (one honest match slice per row — match's rule). Lazy vs
  // eager is unobservable here: strings are immutable, and the spec
  // clones the regex at the call, so nothing can perturb the drain. The
  // eager array IS what the two lowered consumers see anyway (the
  // immediate [...spread] and the for-of walk); a stored iterator's
  // .next() fences as an array member like any other. Non-global
  // regexes throw Node's exact TypeError at runtime, catchably
  // (replaceAll's stance).
  if (receiverKind === "string" && name === "matchAll") {
    const arg0 = call.arguments[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null; // string-pattern form: the SC2020 fence
    if (call.arguments.length !== 1) return null;
    const receiver = lowerReceiver();
    const re = lowerer.lowerExpr(arg0);
    return {
      kind: "regexIntrinsic",
      method: "matchAll",
      receiver,
      args: [re],
      type: arrayOf(arrayOf(STRING)),
      loc,
    };
  }
  // `s.search(re)` — the first match's UTF-16 index, or -1. No g/y fence
  // (unlike test/match): Symbol.search neither reads nor writes lastIndex
  // — a fresh exec from position 0, so /g is irrelevant and /y anchors at
  // 0, exactly Node. Never throws.
  if (receiverKind === "string" && name === "search") {
    const arg0 = call.arguments[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null; // string-pattern form: the SC2020 fence
    if (call.arguments.length !== 1) return null;
    const receiver = lowerReceiver();
    const re = lowerer.lowerExpr(arg0);
    return { kind: "regexIntrinsic", method: "search", receiver, args: [re], type: F64, loc };
  }
  if (
    receiverKind === "string" &&
    (name === "replace" || name === "replaceAll" || name === "split")
  ) {
    const arg0 = call.arguments[0];
    if (!arg0 || lowerer.mapTypeOf(lowerer.typeOf(arg0))?.kind !== "regex") return null;
    const receiver = lowerReceiver();
    // Split's omitted or undefined limit is 2^32-1. Complete it here so
    // both IR backends and the runtime have one required (regex, limit)
    // shape; an optional-number value selects the default at runtime.
    const args = name === "split"
      ? [lowerer.lowerExpr(arg0), lowerSplitLimitArg(lowerer, call.arguments[1], loc)]
      : call.arguments.map((a) => lowerer.lowerExpr(a));
    if (name !== "split" && args[1]?.type.kind !== "string") {
      lowerer.unsupported(
        "SC1120",
        call.arguments[1] ?? call,
        "function replacement values (replacements must be string templates)",
      );
    }
    return {
      kind: "regexIntrinsic",
      method: name,
      receiver,
      args,
      type: name === "split" ? arrayOf(STRING) : STRING,
      loc,
    };
  }
  return null;
}

/** `s.slice(1, 4)` and friends → strIntrinsic. Null when this isn't an
 * ambient string method call (caller keeps its generic rejection).
 * Complete position defaults and conversions here for both backends. */
export function lowerStringMethodCall(lowerer: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  dynReceiver?: () => IrExpr,
  argumentNodes: readonly ts.Expression[] = call.arguments,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  if (dynReceiver === undefined && access.name.text === "localeCompare") return lowerLocaleCompareCall(lowerer, call, access);
  const entry = own(STR_METHODS, access.name.text);
  if (!entry) return null;
  // A validated dyn receiver (`pkg.name.replace(...)` on a JSON.parse
  // value) arrives pre-extracted through `dynReceiver`; its checker type
  // is `any`, so the type/symbol gates don't apply — the dyn value's
  // methods can only BE the string intrinsics.
  if (dynReceiver === undefined) {
    const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
    const nullableString = receiverIr?.kind === "union" &&
      (lowerer.unions.get(receiverIr.unionId)?.arms.some((arm) => arm.kind === "string") ?? false) &&
      (lowerer.unions.get(receiverIr.unionId)?.arms.every((arm) => arm.kind === "string" || isUnitType(arm)) ?? false);
    // `require.main?.filename.startsWith(...)`: the checker types the
    // receiver `string | undefined` (the chain's short-circuit arm), but
    // the entry-module fold lowers it to a compile-time STRING — the
    // suite harness's skip() shape. Everything else keeps the strict
    // string gate.
    if (receiverIr?.kind !== "string" && !nullableString && !isRequireMainFilename(lowerer, access.expression)) return null;
    if (!lowerer.isStdlibMember(access)) return null;
  }
  // The lib declares optional parameters beyond some lowered forms; fence
  // those arities instead of passing arguments the runtime doesn't take.
  if (argumentNodes.length < entry.minArgs || argumentNodes.length > entry.maxArgs) {
    lowerer.noLowering(
      `.${access.name.text} with ${argumentNodes.length} argument${argumentNodes.length === 1 ? "" : "s"} on strings`,
      call,
    );
  }
  const receiver = dynReceiver
    ? dynReceiver()
    : lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
  const loc = locOf(call);
  if (entry.method === "padStart" || entry.method === "padEnd") {
    return lowerStringPaddingCall(lowerer, call, entry.method, receiver, access.expression, argumentNodes);
  }
  const searchMethod = entry.method === "indexOf" || entry.method === "includes" ||
    entry.method === "startsWith" || entry.method === "endsWith";
  if (searchMethod && argumentNodes.length < 2) {
    const needle = lowerStringSearchArgument(lowerer, argumentNodes[0], loc);
    return { kind: "strIntrinsic", method: entry.method, receiver, args: [needle], type: entry.result, loc };
  }
  if (searchMethod && argumentNodes.length === 2) {
    const needleNode = argumentNodes[0]!;
    const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, needleNode);
    let needle = undefinedArg
      ? defaultAfterUndefined(undefinedArg, strLit("undefined", loc))
      : lowerer.lowerExpr(needleNode);
    if (isUnitType(needle.type)) needle = coerceStringSearchValue(lowerer, needle, needleNode, loc);
    const scalarUnion = needle.type.kind === "union" &&
      (lowerer.unions.get(needle.type.unionId)?.arms.every((arm) =>
        arm.kind === "string" || arm.kind === "f64" || arm.kind === "bool" || arm.kind === "bigint" || isUnitType(arm)) ?? false);
    const scalarNeedle = needle.type.kind === "f64" || needle.type.kind === "bool" || needle.type.kind === "bigint" || scalarUnion;
    if (needle.type.kind !== "string" && needle.type.kind !== "dyn" && !scalarNeedle) {
      lowerer.noLowering(`.${entry.method} with '${lowerer.fmt(needle.type)}' search values`, call);
    }
    const defaultPosition: IrExpr = entry.method === "endsWith"
      ? { kind: "bin", op: "/", left: numLit(1, loc), right: numLit(0, loc), type: F64, loc }
      : numLit(0, loc);
    const position = lowerPositionArgument(lowerer, argumentNodes[1], defaultPosition);
    if (needle.type.kind === "string" && (position.type.kind === "f64" || position.type.kind === "jsval")) {
      return { kind: "strIntrinsic", method: entry.method, receiver, args: [needle, position], type: entry.result, loc };
    }
    const key = `str.positions:${entry.method}:${typeKey(needle.type)}:${typeKey(position.type)}`;
    let helper = lowerer.widthHelpers.get(key);
    if (!helper) {
      helper = `%str.positions.${lowerer.widthHelpers.size}`;
      const params = [receiver, needle, position].map((arg, index) => ({ localId: `arg.${index}`, name: `arg${index}`, type: arg.type }));
      const coerceNeedle = needle.type.kind !== "string";
      const search: IrExpr = coerceNeedle ? varRef("search.0", STRING, loc) : varRef("arg.1", STRING, loc);
      const result: IrExpr = {
        kind: "strIntrinsic", method: entry.method, receiver: varRef("arg.0", STRING, loc),
        args: [
          search,
          positionNumber(lowerer, varRef("arg.2", position.type, loc), defaultPosition, argumentNodes[1]!, "string position"),
        ],
        type: entry.result, loc,
      };
      const locals = params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false }));
      const body: IrStmt[] = [];
      if (coerceNeedle) {
        const value = varRef("arg.1", needle.type, loc);
        const init: IrExpr = needle.type.kind === "dyn"
          ? { kind: "libCall", fn: "dyn.toStringCoerce", args: [value], type: STRING, loc }
          : coerceStringSearchValue(lowerer, value, needleNode, loc);
        locals.push({ id: "search.0", name: "search", type: STRING, mutable: false });
        body.push({ kind: "varDecl", localId: "search.0", init, loc });
      }
      body.push({ kind: "return", value: result, loc });
      lowerer.widthHelpers.set(key, helper);
      lowerer.liftedFns.push({
        name: helper, params, returnType: entry.result,
        locals, body, loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver, needle, position], type: entry.result, loc };
  }
  if (entry.method === "charAt" || entry.method === "charCodeAt" || entry.method === "slice" || entry.method === "substring" || entry.method === "repeat") {
    const defaults: IrExpr[] = [numLit(0, loc)];
    if (entry.method === "slice" || entry.method === "substring") {
      defaults.push({ kind: "bin", op: "/", left: numLit(1, loc), right: numLit(0, loc), type: F64, loc });
    }
    const args = defaults.map((value, index) => lowerPositionArgument(lowerer, argumentNodes[index], value));
    const subject = entry.method === "repeat" ? "string repeat count" : "string position";
    // Keep ordinary numeric calls on the direct intrinsic path, including the
    // existing boundary validation for island values in numeric slots.
    if (args.every(arg => arg.type.kind === "f64" || arg.type.kind === "jsval")) {
      return { kind: "strIntrinsic", method: entry.method, receiver, args, type: entry.result, loc };
    }
    // A helper evaluates all arguments before conversions can invoke hooks or
    // throw. Its parameters also give owned strings/unions a per-call lifetime
    // when the call occurs in a loop condition or short-circuit expression.
    const key = `str.positions:${entry.method}:${args.map(arg => typeKey(arg.type)).join(":")}`;
    let helper = lowerer.widthHelpers.get(key);
    if (!helper) {
      helper = `%str.positions.${lowerer.widthHelpers.size}`;
      const params = [receiver, ...args].map((arg, index) => ({ localId: `arg.${index}`, name: `arg${index}`, type: arg.type }));
      const result: IrExpr = {
        kind: "strIntrinsic", method: entry.method, receiver: varRef("arg.0", STRING, loc),
        args: args.map((arg, index) => positionNumber(lowerer, varRef(`arg.${index + 1}`, arg.type, loc), defaults[index]!, argumentNodes[index] ?? call, subject)),
        type: entry.result, loc,
      };
      lowerer.widthHelpers.set(key, helper);
      lowerer.liftedFns.push({
        name: helper, params, returnType: entry.result,
        locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
        body: [{ kind: "return", value: result, loc }], loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver, ...args], type: entry.result, loc };
  }
  const args = entry.method === "split"
    ? [lowerer.lowerExpr(argumentNodes[0]!), lowerSplitLimitArg(lowerer, argumentNodes[1], locOf(call))]
    : argumentNodes.map((a) => lowerer.lowerExpr(a));
  // split's separator must BE a string here (a regex argument was
  // claimed by lowerRegexMethodCall before this path) — the lib's
  // `string | RegExp` union has no lowering as a VALUE.
  if (entry.method === "split" && args[0]!.type.kind !== "string") {
    lowerer.unsupported(
      "SC1090",
      argumentNodes[0]!,
      `'.split()' on a '${lowerer.fmt(args[0]!.type)}' separator (pass a string, or a regex literal)`,
    );
  }
  return {
    kind: "strIntrinsic",
    method: entry.method,
    receiver,
    args,
    type: entry.result,
    loc: locOf(call),
  };
}

/** `a.localeCompare(b)` — the one-argument form only (locales/options
 * select ICU collations that do not exist here). Lowers to an interned
 * synthetic function returning -1/0/1 by CODE-UNIT order — the same
 * ordering as the string relational operators — NOT Node's ICU default
 * collation: a documented divergence (SEMANTICS.md; e.g. Node says
 * "a" < "B" under ICU while code units say "B" < "a"). For same-case
 * ASCII the orders agree. Null when the receiver isn't a stdlib string
 * (caller keeps its generic rejection). */
function lowerLocaleCompareCall(lowerer: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverIr?.kind !== "string") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  if (call.arguments.length !== 1) {
    lowerer.noLowering(
      `.localeCompare with ${call.arguments.length} arguments`,
      call,
      "the locales/options parameters select ICU collations that have no lowering — " +
        "pass exactly the comparison string",
    );
  }
  const receiver = lowerMethodReceiver(lowerer, access.expression, STRING, access.name.text);
  const arg = lowerer.lowerExpr(call.arguments[0]!);
  if (arg.type.kind !== "string") lowerer.badType(call.arguments[0]!, lowerer.typeOf(call.arguments[0]!));
  const key = "localeCompare";
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%str.localeCompare`;
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildLocaleCompareFn(helper, loc));
  }
  return { kind: "call", callee: helper, args: [receiver, arg], type: F64, loc };
}

/** `return a < b ? -1 : a > b ? 1 : 0` over the strCmp primitive (the
 * relational operators' exact machinery — one interned helper, no new IR
 * or runtime surface). */
function buildLocaleCompareFn(name: string, loc: SrcLoc): IrFunction {

  const cmp = (op: "<" | ">"): IrExpr => ({ kind: "strCmp", op, left: varRef("a.0", STRING, loc), right: varRef("b.0", STRING, loc), type: BOOL, loc });
  const body: IrStmt[] = [
    {
      kind: "return",
      value: {
        kind: "ternary",
        cond: cmp("<"),
        then: numLit(-1, loc),
        else_: { kind: "ternary", cond: cmp(">"), then: numLit(1, loc), else_: numLit(0, loc), type: F64, loc },
        type: F64,
        loc,
      },
      loc,
    },
  ];
  return {
    name,
    params: [
      { localId: "a.0", name: "a", type: STRING },
      { localId: "b.0", name: "b", type: STRING },
    ],
    returnType: F64,
    locals: [
      { id: "a.0", name: "a", type: STRING, mutable: true },
      { id: "b.0", name: "b", type: STRING, mutable: true },
    ],
    body,
    loc,
  };
}
