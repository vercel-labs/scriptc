import { keyedHelperName } from "../stable-names.js";
import { numLit, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  typeKey,
} from "../../../ir/ir.js";

/** `os.userInfo()` — the passwd-entry snapshot, Node's uv_os_get_passwd
 * behind the call site's own mapped record shape: username = pw_name,
 * uid/gid = getuid/getgid, shell = pw_shell (as the `string | null`
 * union @types/node declares — POSIX always answers the string arm;
 * null is Node's Windows answer), homedir = pw_dir (the PASSWD home,
 * NOT os.homedir's $HOME-first cascade — Node's own split). The record
 * assembles field-by-field from scalar libCalls in the shape's
 * declaration order; unknown fields and the options argument fence. */
export function lowerOsUserInfoCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(
      "userInfo with options",
      call,
      "the zero-argument call is the lowered form (Node's buffer encoding option has no lowering)",
    );
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "userInfo() where the result is not the UserInfo record",
      call,
      "{ username, uid, gid, shell, homedir } is the supported result shape",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "record") fence();
  const shape = lowerer.shapes.get(result.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) fence();
  const fields: { name: string; value: IrExpr }[] = [];
  for (const f of shape.fields) {
    if (f.name === "username" && f.type.kind === "string") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userName", args: [], type: STRING, loc },
      });
    } else if (f.name === "uid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "process.getuid", args: [], type: F64, loc },
      });
    } else if (f.name === "gid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "process.getgid", args: [], type: F64, loc },
      });
    } else if (f.name === "homedir" && f.type.kind === "string") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userHomedir", args: [], type: STRING, loc },
      });
    } else if (f.name === "shell") {
      // `string | null` (the @types/node shape) wraps the always-string
      // POSIX answer into its arm; a plain-string mapping takes it raw.
      const raw: IrExpr = { kind: "libCall", fn: "os.userShell", args: [], type: STRING, loc };
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
  return { kind: "recordLit", fields, type: result, loc };
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
  const shape = result?.kind === "record" ? lowerer.shapes.get(result.shapeId) : undefined;
  if (
    result?.kind !== "record" ||
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

/** `os.setPriority([pid, ]priority)` — the one-argument form is pid 0
 * (Node's `if (priority === undefined) { priority = pid; pid = 0; }`);
 * the runtime validates both. */
export function lowerOsSetPriorityCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "setPriority with these arguments",
      call,
      "setPriority(priority) or setPriority(pid, priority) takes numbers",
    );
  }
  const [pid, priority] =
    args.length === 1
      ? [numLit(0, loc), lowerer.lowerExprExpecting(args[0]!, F64)]
      : [lowerer.lowerExprExpecting(args[0]!, F64), lowerer.lowerExprExpecting(args[1]!, F64)];
  return { kind: "libCall", fn: "os.setPriority", args: [pid, priority], type: VOID, loc };
}

/** `os.getPriority(pid?)` — an omitted or undefined pid is 0 (Node's
 * `if (pid === undefined) pid = 0`); the runtime validates the rest. */
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
  let pid: IrExpr = numLit(0, loc);
  if (arg) {
    const value = lowerer.lowerExpr(arg);
    if (value.type.kind === "f64") {
      pid = value;
    } else if (
      value.type.kind === "union" &&
      lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0 &&
      lowerer.armTag(value.type.unionId, F64) >= 0 &&
      lowerer.unions.get(value.type.unionId)?.arms.length === 2
    ) {
      const unionId = value.type.unionId;
      const temp = lowerer.declareHiddenLocal("%pid", value.type);
      const ref = varRef(temp.id, value.type, loc);
      pid = {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: temp.id, init: value, loc }],
        result: {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId,
            tag: lowerer.armTag(unionId, UNDEFINED_T),
            negated: false,
            value: ref,
            type: BOOL,
            loc,
          },
          then: numLit(0, loc),
          else_: {
            kind: "unionNarrow",
            unionId,
            tag: lowerer.armTag(unionId, F64),
            value: ref,
            type: F64,
            loc,
          },
          type: F64,
          loc,
        },
        type: F64,
        loc,
      };
    } else {
      pid = lowerer.lowerExprExpecting(arg, F64);
    }
  }
  return { kind: "libCall", fn: "os.getPriority", args: [pid], type: F64, loc };
}
