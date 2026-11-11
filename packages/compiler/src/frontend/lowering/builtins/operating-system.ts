import { keyedHelperName } from "../stable-names.js";
import {
  boolLit,
  dynUndefinedExpr,
  nodeThrowExpr,
  numLit,
  strLit,
  varRef,
} from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { spellsInertValue } from "../builtin-member-writes.js";
import { isJsSourceFile } from "../../program.js";
import { knownBufEncoding } from "../containers/bytes.js";
import { type Lowerer } from "../lowerer.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  NULL_T,
  type IrExpr,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  sortArms,
  typeKey,
} from "../../../ir/ir.js";

/** `UserInfo` as @types/node declares it (the mapper intern keys and
 * declared order): the record os.userInfo() answers even when the checker
 * could not tie an untyped JavaScript call to that declaration. */
function canonicalUserInfoType(lowerer: Lowerer, bytes: boolean): IrType & { kind: "record" } {
  const text = bytes ? BYTES_U8 : STRING;
  const shell: IrType = bytes
    ? BYTES_U8
    : { kind: "union", unionId: lowerer.unions.intern(sortArms([NULL_T, STRING])) };
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "gid", type: F64 },
        { name: "homedir", type: text },
        { name: "shell", type: shell },
        { name: "uid", type: F64 },
        { name: "username", type: text },
      ],
      false,
      undefined,
      ["uid", "gid", "username", "homedir", "shell"],
    ),
  };
}

/** A non-string encoding value Node's ParseEncoding reads as its utf8
 * default: null, undefined, and the other primitives (an unknown spelling
 * never selects a decoder). */
function absentEncodingValue(lowerer: Lowerer, value: ts.Expression): boolean {
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    (ts.isIdentifier(value) &&
      value.text === "undefined" &&
      (lowerer.isStdlibGlobal(value, "undefined") ||
        (lowerer.typeOf(value).flags & ts.TypeFlags.Undefined) !== 0))
  );
}

/** `os.userInfo()` — the passwd-entry snapshot, Node's uv_os_get_passwd
 * for the effective uid behind the call site's own mapped record shape:
 * username = pw_name, uid/gid = pw_uid/pw_gid (the user's primary group,
 * not the process gid; -1 on Windows), shell = pw_shell (as the `string | null`
 * union @types/node declares — POSIX always answers the string arm;
 * null is Node's Windows answer), homedir = pw_dir (the PASSWD home,
 * NOT os.homedir's $HOME-first cascade — Node's own split). A literal
 * `encoding` names the form of the three strings: 'buffer' for Buffers,
 * another Buffer encoding for the passwd text re-encoded in it, utf8
 * otherwise. The record assembles field-by-field from scalar libCalls in
 * the shape's declaration order; unknown fields and a runtime encoding
 * fence. */
export function lowerOsUserInfoCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  if (args.length > 1) {
    lowerer.noLowering(`userInfo with ${args.length} arguments`, call);
  }
  // The options object names the encoding Node's binding hands the passwd
  // bytes to StringBytes::Encode: 'buffer' answers the three strings as
  // Buffers, any other Buffer encoding (aliases and letter case folded)
  // answers the passwd text re-encoded in it, and a spelling Node does not
  // know reads as utf8 — its ParseEncoding default. Node evaluates the
  // argument at the call site and then reads `options.encoding` off the
  // object it built, so the argument's own expressions run here in source
  // order and the last definition of the member decides the record. The
  // shape must be spelled at compile time: a member whose value (or key)
  // Node only learns while running the program fences, never reads absent.
  let encoding = "utf8";
  const sideEffects: IrExpr[] = [];
  const evaluate = (node: ts.Expression): void => {
    if (spellsInertValue(node)) return;
    const expr = lowerer.lowerExpr(node);
    // `undefined` and `null` lower to a bare unitLit, which carries no
    // effect and is not a valid IR expression statement.
    if (expr.kind === "unitLit") return;
    sideEffects.push(expr);
  };
  if (args.length === 1) {
    let options: ts.Expression = args[0]!;
    while (ts.isParenthesizedExpression(options)) options = options.expression;
    const runtimeEncoding = (node: ts.Node): never =>
      lowerer.noLowering(
        "userInfo with a runtime encoding",
        node,
        "the encoding must be the literal 'buffer' or a non-buffer string literal in an options object spelled at the call site",
      );
    /** The property key a member's name spells, or `undefined` when only
     * the program can compute it. `run` is the expression a computed name
     * evaluates at the call site beyond a literal the source spells. */
    const staticKey = (name: ts.PropertyName): { key: string | undefined; run?: ts.Expression } => {
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return { key: name.text };
      if (ts.isNumericLiteral(name)) return { key: String(Number(name.text)) };
      if (!ts.isComputedPropertyName(name)) return { key: undefined };
      let expr: ts.Expression = name.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isStringLiteralLike(expr)) return { key: expr.text };
      if (ts.isNumericLiteral(expr)) return { key: String(Number(expr.text)) };
      // A computed key whose expression the checker pinned to a literal:
      // ToPropertyKey answers that spelling, and the expression still runs.
      const t = lowerer.typeOf(expr);
      if ((t.flags & ts.TypeFlags.StringLiteral) !== 0)
        return { key: (t as ts.StringLiteralType).value, run: expr };
      if ((t.flags & ts.TypeFlags.NumberLiteral) !== 0)
        return { key: String((t as ts.NumberLiteralType).value), run: expr };
      return { key: undefined };
    };
    const encodingOf = (text: string): string =>
      text.toLowerCase() === "buffer" ? "buffer" : (knownBufEncoding(text) ?? "utf8");
    // Node reads `options.encoding` only when the argument is an object
    // (every other value is replaced with null and answers the default utf8
    // record), but the argument itself is always evaluated, so its effects
    // stay. A declared type that may carry an encoding member makes the
    // decoder a runtime choice, so it keeps the fence.
    if (!ts.isObjectLiteralExpression(options)) {
      const t = lowerer.typeOf(options);
      if (
        (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0 ||
        lowerer.checker.getPropertyOfType(t, "encoding") !== undefined
      )
        runtimeEncoding(options);
      evaluate(options);
    } else {
      // Walk the members the way Node builds the object: every computed key
      // and property value runs (in source order, before the binding reads
      // anything), a method or accessor is only defined, and the last
      // definition of `encoding` is what the binding reads. Another
      // member's value is dead unless spelling it runs something, so it is
      // evaluated for its effects and dropped.
      let decision: { text: string } | { runtime: ts.Node } = { text: "utf8" };
      for (const prop of options.properties.nodes) {
        if (ts.isSpreadAssignment(prop)) {
          // The spread copies the source's own properties and reads them at
          // call time: the encoding can come from the source.
          lowerer.noLowering(
            "userInfo options spread from another object",
            prop,
            "pass an options object literal with only the encoding property",
          );
        }
        if (ts.isMethodDeclaration(prop)) {
          // A method's value is a function, never the encoding string; its
          // body does not run here. An unresolved computed key may name a
          // member whose value the binding would read.
          const k = staticKey(prop.name);
          if (k.run) evaluate(k.run);
          if (k.key === undefined) decision = { runtime: prop };
          else if (k.key === "encoding") decision = { text: "utf8" };
          continue;
        }
        if (ts.isGetAccessorDeclaration(prop)) {
          // Node reads through the getter: its value is the program's to
          // compute, and the record's shape depends on it.
          const k = staticKey(prop.name);
          if (k.run) evaluate(k.run);
          if (k.key === undefined || k.key === "encoding") decision = { runtime: prop };
          continue;
        }
        if (ts.isSetAccessorDeclaration(prop)) {
          // A setter-only member reads as undefined: the utf8 default.
          const k = staticKey(prop.name);
          if (k.run) evaluate(k.run);
          if (k.key === undefined) decision = { runtime: prop };
          else if (k.key === "encoding") decision = { text: "utf8" };
          continue;
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          if (ts.isIdentifier(prop.name) && prop.name.text !== "encoding") {
            // Node evaluates the variable read; that read is the member's
            // only effect, and dropping it would drop a dead-zone throw.
            evaluate(prop.name);
            continue;
          }
          if (!ts.isIdentifier(prop.name)) {
            decision = { runtime: prop };
            continue;
          }
          // The value is the variable's, not a literal spelled here: a
          // constant whose type pins the spelling reads as that encoding.
          const t = lowerer.typeOf(prop.name);
          if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) {
            evaluate(prop.name);
            decision = { text: encodingOf((t as ts.StringLiteralType).value) };
          } else {
            decision = { runtime: prop };
          }
          continue;
        }
        if (!ts.isPropertyAssignment(prop)) {
          lowerer.noLowering(
            "userInfo options beyond a plain encoding property",
            prop,
            "pass { encoding: 'buffer' } for Buffers or no argument for the string record",
          );
        }
        const k = staticKey(prop.name);
        if (k.run) evaluate(k.run);
        if (k.key === undefined) {
          // Whether the run-time key names `encoding` is the program's to
          // decide.
          evaluate(prop.initializer);
          decision = { runtime: prop };
          continue;
        }
        if (k.key !== "encoding") {
          // Node never reads another member; evaluating the initializer
          // keeps the effects spelling it runs.
          evaluate(prop.initializer);
          continue;
        }
        let value: ts.Expression = prop.initializer;
        while (ts.isParenthesizedExpression(value)) value = value.expression;
        if (ts.isStringLiteralLike(value)) {
          decision = { text: encodingOf(value.text) };
        } else {
          const t = lowerer.typeOf(value);
          if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) {
            // A constant whose type pins the spelling: the binding reads
            // that string, and the read itself is evaluated.
            evaluate(value);
            decision = { text: encodingOf((t as ts.StringLiteralType).value) };
          } else if (absentEncodingValue(lowerer, value)) {
            // null, undefined and the other non-strings are ParseEncoding's
            // utf8 default.
            decision = { text: "utf8" };
          } else {
            decision = { runtime: prop };
          }
        }
      }
      if ("runtime" in decision) runtimeEncoding(decision.runtime);
      else encoding = decision.text;
    }
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "userInfo() where the result is not the UserInfo record",
      call,
      "{ username, uid, gid, shell, homedir } is the supported result shape",
    );
  const isBytes = (t: IrType): boolean => t.kind === "bytes" && t.elem === "u8";
  const buffer = encoding === "buffer";
  const canonical = () => canonicalUserInfoType(lowerer, buffer);
  /** Whether a record shape's text fields are the ones this encoding
   * answers: Buffers for the Buffer form, strings (shell nullable)
   * otherwise. */
  const encodesAs = (shape: IrRecordShape): boolean =>
    shape.fields.every((f) => {
      if (f.name === "uid" || f.name === "gid") return f.type.kind === "f64";
      if (buffer) return isBytes(f.type);
      if (f.type.kind === "string") return true;
      return (
        f.name === "shell" && f.type.kind === "union" && lowerer.armTag(f.type.unionId, STRING) >= 0
      );
    });
  const jsCall = isJsSourceFile(ts.getSourceFileOfNode(call));
  /** The record the call's result type names. An untyped JavaScript call
   * whose overloads the checker could not tie to a UserInfo type (an
   * options object with extra members, a non-object argument — Node accepts
   * both) still answers Node's record, so the canonical shape stands in for
   * the missing type; an intersection of the overloads' result types maps
   * to nothing, so both "the mapper declined" (null) and "no IR type"
   * (undefined) count. The encoding decides what the fields hold, and the
   * checker's overload answer can disagree with it — untyped JavaScript's
   * "Buffer" spelling resolves to the string record while the binding
   * answers Buffers — so a JavaScript call takes the canonical record for
   * the encoding it asked for. A typed call that names another result shape
   * keeps the fence. */
  const userInfoRecord = (): IrType & { kind: "record" } => {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (mapped?.kind === "record") {
      const mappedShape = lowerer.shapes.get(mapped.shapeId);
      if (!(jsCall && mappedShape && !encodesAs(mappedShape))) return mapped;
    } else if (mapped !== null && mapped !== undefined) {
      fence();
    }
    if (jsCall) return canonical();
    return fence();
  };
  const result = userInfoRecord();
  const shape = lowerer.shapes.get(result.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) fence();
  const fields: { name: string; value: IrExpr }[] = [];
  const textField = (
    fn: "os.userName" | "os.userHomedir" | "os.userShell",
    bufferFn: "os.userNameBuf" | "os.userHomedirBuf" | "os.userShellBuf",
  ): IrExpr => {
    if (buffer) return { kind: "libCall", fn: bufferFn, args: [], type: BYTES_U8, loc };
    if (encoding === "utf8") return { kind: "libCall", fn, args: [], type: STRING, loc };
    // Any other encoding re-encodes the passwd bytes: the field's own bytes
    // go through the decoder Buffer#toString uses for that name, which is
    // the StringBytes::Encode Node's binding calls on the same bytes.
    return {
      kind: "bytesIntrinsic",
      method: "toString",
      receiver: { kind: "libCall", fn: bufferFn, args: [], type: BYTES_U8, loc },
      args: [strLit(encoding, loc)],
      type: STRING,
      loc,
    };
  };
  for (const f of shape.fields) {
    if (f.name === "username" && (buffer ? isBytes(f.type) : f.type.kind === "string")) {
      fields.push({ name: f.name, value: textField("os.userName", "os.userNameBuf") });
    } else if (f.name === "uid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userUid", args: [], type: F64, loc },
      });
    } else if (f.name === "gid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userGid", args: [], type: F64, loc },
      });
    } else if (f.name === "homedir" && (buffer ? isBytes(f.type) : f.type.kind === "string")) {
      fields.push({
        name: f.name,
        value: textField("os.userHomedir", "os.userHomedirBuf"),
      });
    } else if (f.name === "shell" && buffer && isBytes(f.type)) {
      fields.push({ name: f.name, value: textField("os.userShell", "os.userShellBuf") });
    } else if (f.name === "shell" && !buffer) {
      // `string | null` (the @types/node shape) wraps the always-string
      // POSIX answer into its arm; a plain-string mapping takes it raw.
      const raw: IrExpr = textField("os.userShell", "os.userShellBuf");
      if (f.type.kind === "string") {
        fields.push({ name: f.name, value: raw });
      } else if (f.type.kind === "union") {
        const tag = lowerer.armTag(f.type.unionId, STRING);
        if (tag < 0) fence();
        fields.push({
          name: f.name,
          value: { kind: "unionWrap", unionId: f.type.unionId, tag, value: raw, type: f.type, loc },
        });
      } else {
        fence();
      }
    } else {
      fence();
    }
  }
  // One passwd lookup for the whole record, then the fields read it: Node
  // builds userInfo() from a single uv_os_get_passwd, and five separate
  // reads of the same entry are five times the system call.
  return {
    kind: "seqExpr",
    stmts: [
      ...sideEffects.map((expr): IrStmt => ({ kind: "exprStmt", expr, loc: expr.loc })),
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "os.userInfoBegin", args: [], type: VOID, loc },
        loc,
      },
    ],
    result: { kind: "recordLit", fields, type: result, loc },
    type: result,
    loc,
  };
}

export function lowerOsNetworkInterfacesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(
      `networkInterfaces with ${call.arguments.nodes.length} arguments`,
      call,
      "networkInterfaces() takes no arguments",
    );
  }
  // Annotated as a never-returning const so tsc's control flow narrows
  // through the structural checks below.
  const fence: () => never = () =>
    lowerer.noLowering(
      "networkInterfaces() where the result is not the NetworkInterfaceInfo dictionary",
      call,
      "@types/node's NodeJS.Dict<NetworkInterfaceInfo[]> shape is the supported result",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "record") fence();
  const dictShape = lowerer.shapes.get(result.shapeId);
  if (!dictShape || dictShape.tuple || dictShape.fields.length > 0 || !dictShape.indexValue)
    fence();
  const iv = dictShape.indexValue;
  if (iv.kind !== "union") fence();
  const ivDef = lowerer.unions.get(iv.unionId);
  const arrArm = ivDef?.arms.find((a) => a.kind === "array");
  if (
    !ivDef ||
    ivDef.arms.length !== 2 ||
    arrArm?.kind !== "array" ||
    !ivDef.arms.some((a) => a.kind === "undefinedT")
  )
    fence();
  const info = arrArm.elem;
  if (info.kind !== "union") fence();
  const infoDef = lowerer.unions.get(info.unionId);
  if (!infoDef || infoDef.arms.length !== 2) fence();
  // One arm per family, distinguished by scopeid: plain number = IPv6,
  // `number | undefined` = IPv4. Every other field is shared.
  let saw4 = false;
  let saw6 = false;
  for (const arm of infoDef.arms) {
    if (arm.kind !== "record") fence();
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== 7) fence();
    const f = (name: string): IrType | undefined => shape.fields.find((x) => x.name === name)?.type;
    for (const s of ["address", "family", "mac", "netmask"]) {
      if (f(s)?.kind !== "string") fence();
    }
    if (f("internal")?.kind !== "bool") fence();
    const cidr = f("cidr");
    const cidrDef = cidr?.kind === "union" ? lowerer.unions.get(cidr.unionId) : undefined;
    if (
      !cidrDef ||
      cidrDef.arms.length !== 2 ||
      !cidrDef.arms.some((a) => a.kind === "string") ||
      !cidrDef.arms.some((a) => a.kind === "nullT")
    ) {
      fence();
    }
    const scopeid = f("scopeid");
    if (scopeid?.kind === "f64") {
      saw6 = true;
    } else {
      const sDef = scopeid?.kind === "union" ? lowerer.unions.get(scopeid.unionId) : undefined;
      if (
        !sDef ||
        sDef.arms.length !== 2 ||
        !sDef.arms.some((a) => a.kind === "f64") ||
        !sDef.arms.some((a) => a.kind === "undefinedT")
      ) {
        fence();
      }
      saw4 = true;
    }
  }
  if (!saw4 || !saw6) fence();
  return { kind: "libCall", fn: "os.networkInterfaces", args: [], type: result, loc };
}

/** `os.cpus()` — one uv_cpu_info snapshot as the call site's CpuInfo[]:
 * os.cpusTake reads every CPU and answers the count, and a lifted helper
 * builds one { model, speed, times: { user, nice, sys, idle, irq } }
 * record per CPU from the snapshot accessors, in the mapped shapes' own
 * field order. Other result shapes fence. */
export function lowerOsCpusCall(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(
      `cpus with ${call.arguments.nodes.length} arguments`,
      call,
      "cpus() takes no arguments",
    );
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "cpus() where the result is not the CpuInfo array",
      call,
      "{ model, speed, times: { user, nice, sys, idle, irq } }[] is the supported result shape",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "array" || result.elem.kind !== "record") fence();
  const info = result.elem;
  const infoShape = lowerer.shapes.get(info.shapeId);
  if (!infoShape || infoShape.tuple || infoShape.indexValue || infoShape.fields.length !== 3)
    fence();
  const timesField = infoShape.fields.find((f) => f.name === "times");
  const timesT = timesField?.type;
  if (timesT?.kind !== "record") fence();
  const timesShape = lowerer.shapes.get(timesT.shapeId);
  const TIMES = ["user", "nice", "sys", "idle", "irq"];
  if (
    !timesShape ||
    timesShape.tuple ||
    timesShape.indexValue ||
    timesShape.fields.length !== TIMES.length ||
    timesShape.fields.some((f) => !TIMES.includes(f.name) || f.type.kind !== "f64")
  )
    fence();
  if (
    infoShape.fields.find((f) => f.name === "model")?.type.kind !== "string" ||
    infoShape.fields.find((f) => f.name === "speed")?.type.kind !== "f64"
  )
    fence();
  const key = `os.cpus:${typeKey(result)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%os.cpus", key);
    lowerer.valueHelpers.set(key, helper);
    const index = varRef("i.0", F64, loc);
    const field = (k: number): IrExpr => ({
      kind: "libCall",
      fn: "os.cpusField",
      args: [index, numLit(k, loc)],
      type: F64,
      loc,
    });
    const times: IrExpr = {
      kind: "recordLit",
      fields: timesShape.fields.map((f) => ({
        name: f.name,
        value: field(1 + TIMES.indexOf(f.name)),
      })),
      type: timesT,
      loc,
    };
    const record: IrExpr = {
      kind: "recordLit",
      fields: infoShape.fields.map((f) => ({
        name: f.name,
        value:
          f.name === "model"
            ? { kind: "libCall", fn: "os.cpusModel", args: [index], type: STRING, loc }
            : f.name === "speed"
              ? field(0)
              : times,
      })),
      type: info,
      loc,
    };
    const out = varRef("out.0", result, loc);
    const count = varRef("n.0", F64, loc);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "n.0",
        init: { kind: "libCall", fn: "os.cpusTake", args: [], type: F64, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: result, loc },
        loc,
      },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
        cond: { kind: "bin", op: "<", left: index, right: count, type: BOOL, loc },
        update: {
          kind: "assign",
          localId: "i.0",
          value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc },
          loc,
        },
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: out,
              args: [record],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: out, loc },
    ];
    lowerer.liftedFns.push({
      name: helper,
      params: [],
      returnType: result,
      locals: [
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "out.0", name: "out", type: result, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [], type: result, loc };
}

const PATH_FIELDS = ["root", "dir", "base", "ext", "name"];

/** `path.parse(p)` — the runtime's [root, dir, base, ext, name] parts as
 * the call site's ParsedPath record (a lifted helper per shape). Other
 * result shapes fence. */
export function lowerPathParseCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  win32: boolean,
  loc: SrcLoc,
): IrExpr {
  const arg = call.arguments.nodes[0];
  if (call.arguments.nodes.length !== 1 || !arg || ts.isSpreadElement(arg)) {
    lowerer.noLowering("path.parse without exactly one path", call, "parse(path) takes one string");
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result === null || result.kind === "dyn") {
    // The untyped lane (a require binding, or a call the checker types as
    // `any`): Node's parse checks the path at runtime and answers the fresh
    // object with root, dir, base, ext and name, which the runtime builds.
    return {
      kind: "libCall",
      fn: "path.parseValue",
      args: [lowerer.coerceInto(arg, lowerer.lowerExpr(arg), DYN), boolLit(win32, loc)],
      type: DYN,
      loc,
    };
  }
  const shape = result.kind === "record" ? lowerer.shapes.get(result.shapeId) : undefined;
  if (
    result.kind !== "record" ||
    !shape ||
    shape.tuple ||
    shape.indexValue ||
    shape.fields.length !== PATH_FIELDS.length ||
    shape.fields.some((f) => !PATH_FIELDS.includes(f.name) || f.type.kind !== "string")
  ) {
    lowerer.noLowering(
      "path.parse where the result is not the ParsedPath record",
      call,
      "{ root, dir, base, ext, name } is the supported result shape",
    );
  }
  const fn = win32 ? "path.win32Parse" : "path.parse";
  const key = `${fn}:${typeKey(result)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%path.parse", key);
    lowerer.valueHelpers.set(key, helper);
    const parts = varRef("parts.0", arrayOf(STRING), loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "path.0", name: "path", type: STRING }],
      returnType: result,
      locals: [
        { id: "path.0", name: "path", type: STRING, mutable: false },
        { id: "parts.0", name: "parts", type: arrayOf(STRING), mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "parts.0",
          init: {
            kind: "libCall",
            fn,
            args: [varRef("path.0", STRING, loc)],
            type: arrayOf(STRING),
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: shape.fields.map((f) => ({
              name: f.name,
              value: {
                kind: "arrayGet",
                arr: parts,
                index: numLit(PATH_FIELDS.indexOf(f.name), loc),
                type: STRING,
                loc,
              },
            })),
            type: result,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "call",
    callee: helper,
    args: [lowerer.lowerExprExpecting(arg, STRING)],
    type: result,
    loc,
  };
}

/** `path.format(pathObject)` — the object's root, dir, base, name and ext
 * (each a string or an optional string; absent fields and undefined read
 * as "", which Node's `||` treats alike) passed to the runtime's format.
 * Other argument shapes fence. */
export function lowerPathFormatCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  win32: boolean,
  loc: SrcLoc,
): IrExpr {
  const arg = call.arguments.nodes[0];
  if (call.arguments.nodes.length !== 1 || !arg || ts.isSpreadElement(arg)) {
    lowerer.noLowering(
      "path.format without exactly one object",
      call,
      "format(pathObject) takes one object",
    );
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "path.format with this argument type",
      arg,
      "an object whose root, dir, base, name and ext are strings or optional strings",
    );
  const value = lowerer.lowerExpr(arg);
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if ((result === null || result.kind === "dyn") && value.type.kind === "dyn") {
    // The untyped lane: the runtime reads dir, root, base, name and ext off
    // the object as Node's _format does, and answers base itself when there
    // is no dir, which need not be a string. A statically typed record
    // keeps the verified shape below.
    return {
      kind: "libCall",
      fn: "path.formatValue",
      args: [value, boolLit(win32, loc)],
      type: DYN,
      loc,
    };
  }
  if (value.type.kind !== "record") fence();
  const recordT = value.type;
  const shape = lowerer.shapes.get(recordT.shapeId);
  if (!shape || shape.tuple || shape.indexValue) fence();
  const fieldTypes = new Map<string, IrType>();
  for (const f of shape.fields) {
    if (!PATH_FIELDS.includes(f.name)) continue;
    const ok =
      f.type.kind === "string" ||
      (f.type.kind === "union" &&
        (lowerer.unions
          .get(f.type.unionId)
          ?.arms.every((a) => a.kind === "string" || a.kind === "undefinedT") ??
          false));
    if (!ok) fence();
    fieldTypes.set(f.name, f.type);
  }
  const fn = win32 ? "path.win32Format" : "path.format";
  const key = `${fn}:${typeKey(recordT)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%path.format", key);
    lowerer.valueHelpers.set(key, helper);
    const object = varRef("object.0", recordT, loc);
    const read = (name: string): IrExpr => {
      const type = fieldTypes.get(name);
      if (!type) return strLit("", loc);
      const get: IrExpr = {
        kind: "recordGet",
        obj: object,
        shapeId: recordT.shapeId,
        field: name,
        type,
        loc,
      };
      if (type.kind === "string") return get;
      const unionId = (type as IrType & { kind: "union" }).unionId;
      return {
        kind: "ternary",
        cond: {
          kind: "unionIsTag",
          unionId,
          tag: lowerer.armTag(unionId, UNDEFINED_T),
          negated: false,
          value: get,
          type: BOOL,
          loc,
        },
        then: strLit("", loc),
        else_: {
          kind: "unionNarrow",
          unionId,
          tag: lowerer.armTag(unionId, STRING),
          value: get,
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      };
    };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "object.0", name: "object", type: recordT }],
      returnType: STRING,
      locals: [{ id: "object.0", name: "object", type: recordT, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn,
            args: ["root", "dir", "base", "name", "ext"].map(read),
            type: STRING,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: STRING, loc };
}

/** A priority argument for the checked-dynamic form: the boxed value
 * Node's validateInteger renders, or null when the type cannot enter the
 * checked-dynamic tree (the caller keeps the checked conversion then). */
function priorityDynArg(lowerer: Lowerer, value: IrExpr): IrExpr | null {
  if (value.type.kind === "dyn") return value;
  if (!lowerer.dynConvertible(value.type)) return null;
  return { kind: "dynFrom", value, type: DYN, loc: value.loc };
}

/** `os.setPriority([pid, ]priority)` — the one-argument form is pid 0
 * (Node's `if (priority === undefined) { priority = pid; pid = 0; }`);
 * the runtime validates both. */
export function lowerOsSetPriorityCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "setPriority with these arguments",
      call,
      "setPriority(priority) or setPriority(pid, priority) takes numbers",
    );
  }
  if (args.length === 0) {
    // Node's own `if (priority === undefined)` branch reads the missing
    // argument as undefined and validateInteger throws on it.
    return nodeThrowExpr(
      1,
      "ERR_INVALID_ARG_TYPE",
      'The "priority" argument must be of type number. Received undefined',
      VOID,
      loc,
    );
  }
  // The arguments evaluate in source order, before the call — the same
  // order Node's own parameter evaluation uses.
  const values = args.map((arg) => lowerer.lowerExpr(arg));
  if (values.every((value) => value.type.kind === "f64")) {
    return {
      kind: "libCall",
      fn: "os.setPriority",
      args: values.length === 1 ? [numLit(0, loc), values[0]!] : [values[0]!, values[1]!],
      type: VOID,
      loc,
    };
  }
  // An argument that is not statically a number (untyped JavaScript's
  // strings, booleans and objects, and values only the runtime knows):
  // Node's own ladder runs at run time — a missing or undefined priority
  // selects the one-argument form, validateInteger renders its Received
  // tail from the value itself, and a valid number still sets the
  // priority.
  const dyns = values.map((value) => priorityDynArg(lowerer, value));
  if (dyns.every((dyn) => dyn !== null)) {
    return {
      kind: "libCall",
      fn: "os.setPriorityChk",
      args: [dyns[0]!, dyns[1] ?? dynUndefinedExpr(loc)],
      type: VOID,
      loc,
    };
  }
  // A value outside the checked-dynamic tree: the usual checked
  // conversion, which raises its own TypeError for a non-number.
  const coerce = (value: IrExpr): IrExpr => lowerer.coerceToExpected(value, F64);
  return {
    kind: "libCall",
    fn: "os.setPriority",
    args:
      values.length === 1
        ? [numLit(0, loc), coerce(values[0]!)]
        : [coerce(values[0]!), coerce(values[1]!)],
    type: VOID,
    loc,
  };
}

/** `os.getPriority(pid?)` — an omitted or undefined pid is 0 (Node's
 * default parameter); the runtime validates the rest. */
export function lowerOsGetPriorityCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const arg = call.arguments.nodes[0];
  if (call.arguments.nodes.length > 1 || (arg && ts.isSpreadElement(arg))) {
    lowerer.noLowering(
      "getPriority with these arguments",
      call,
      "getPriority(pid?) takes one number",
    );
  }
  const direct = (pid: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "os.getPriority",
    args: [pid],
    type: F64,
    loc,
  });
  if (!arg) return direct(numLit(0, loc));
  const value = lowerer.lowerExpr(arg);
  if (value.type.kind === "f64") return direct(value);
  if (value.type.kind === "undefinedT") {
    // Node's default parameter: an undefined pid reads the current
    // process's priority (pid 0). The expression still evaluates.
    return direct(
      value.kind === "unitLit"
        ? numLit(0, loc)
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: value, loc }],
            result: numLit(0, loc),
            type: F64,
            loc,
          },
    );
  }
  // Anything else (a string, a boolean, an object, a value only the
  // runtime knows): Node's validateInteger runs in the runtime, which
  // renders its type error from the value itself.
  const dyn = priorityDynArg(lowerer, value);
  if (dyn) return { kind: "libCall", fn: "os.getPriorityChk", args: [dyn], type: F64, loc };
  return direct(lowerer.coerceToExpected(value, F64));
}
