/** The value a read of a Node 24 global native code does not provide
 * answers (host-globals.ts). Node has the constructor, so a read must answer
 * a constructor: the eager read at module init (`export const FormData =
 * instanceOf(globalThis.FormData, …)` in effect's Schema) is a value read,
 * not a use, and refusing it rejects the module before its capability probe
 * ever runs.
 *
 * The value is what Node's class is to native code: `typeof` answers
 * "function", `name` and `length` are Node's, `instanceof` answers false for
 * every value native code can produce (the constructor's `prototype` is an
 * object no value's prototype chain reaches), and constructing or calling it
 * throws the SC2020 fence its direct use reports — native code can never
 * produce an instance. Reads that ARE a use (`new WebSocket(url)`,
 * `FormData()`) keep the compile fence, which a JavaScript source defers to
 * exactly that throw.
 *
 * The constructor is a zero-parameter closure whose function is marked
 * `ownsPrototype`: the runtime gives every such function its own
 * `prototype` object with `constructor` on it (scr_dyn_fn_table), the same
 * shape a program's function declaration has, so `FormData.prototype`,
 * `FormData.prototype.constructor === FormData` and `x instanceof FormData`
 * all answer what Node answers without any property definition here. */
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, type IrExpr, type IrLocal, type IrStmt } from "../../ir/ir.js";
import { boolLit, varRef } from "../../ir/build.js";
import { hostGlobalDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";
import { hostGlobalLength } from "./host-globals.js";
import { locOf } from "../program.js";

/** The constructor value the global `name` reads as. Built once per program
 * (the helper answers the same value every time, as the global object does).
 * A read reports no fence: it does not throw. The value throws the SC2020
 * fence when it is constructed or called, and the call and `new` sites that
 * can see the global report it there (lowerer.hostGlobalFence). */
export function hostGlobalValue(lowerer: Lowerer, name: string, node: ts.Node): IrExpr {
  const loc = locOf(node);
  const helper = `%builtin.hostGlobal.${name}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === helper))
    defineHostGlobalBuilder(lowerer, name, helper, node);
  lowerer.noteEdge(helper);
  return { kind: "call", callee: helper, args: [], type: DYN, loc };
}

/** The lifted function that builds the constructor once and answers the same
 * value afterwards. */
function defineHostGlobalBuilder(
  lowerer: Lowerer,
  name: string,
  helper: string,
  node: ts.Node,
): void {
  const loc = locOf(node);
  const fence = `%builtin.fence.global.${name}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === fence)) {
    const diag = hostGlobalDiag(name, loc);
    lowerer.liftedFns.push({
      name: fence,
      ownsPrototype: true,
      params: [],
      locals: [],
      returnType: DYN,
      body: [{ kind: "runtimeFence", code: diag.code, message: fenceMessage(diag, node), loc }],
      loc,
    });
  }
  const storage = `%g.${helper}`;
  const ready = `${storage}%ready`;
  lowerer.globalsList.push(
    { id: storage, name: `${name} global value`, type: DYN, mutable: true },
    { id: ready, name: "%ready", type: BOOL, mutable: true },
  );
  const length = hostGlobalLength(name);
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: varRef(ready, BOOL, loc),
      then: [{ kind: "return", value: varRef(storage, DYN, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "assign",
      localId: storage,
      value: {
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: fence,
          captures: [],
          type: { kind: "func", params: [], ret: DYN },
          loc,
        },
        fnName: name,
        ...(length !== undefined ? { fnLength: length } : {}),
        type: DYN,
        loc,
      },
      loc,
    },
    // The constructor's own [[Prototype]]: a plain object, so the `instanceof`
    // prototype walk over a FUNCTION value ends at null instead of throwing
    // the runtime's unsupported-getPrototypeOf refusal (the walk starts at the
    // value's [[Prototype]]). Nothing native code produces reaches it, so
    // `x instanceof FormData` answers false for every value native code can
    // produce, functions included.
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.setPrototype",
        args: [varRef(storage, DYN, loc), { kind: "dynObjLit", fields: [], type: DYN, loc }],
        type: DYN,
        loc,
      },
      loc,
    },
    { kind: "assign", localId: ready, value: boolLit(true, loc), loc },
    { kind: "return", value: varRef(storage, DYN, loc), loc },
  ];
  const locals: IrLocal[] = [];
  lowerer.liftedFns.push({ name: helper, params: [], locals, returnType: DYN, body, loc });
  lowerer.shareHelper(helper);
}

/** The thrown message, in the shape every deferred fence throws: the
 * diagnostic's message at the site that first read the value. */
function fenceMessage(
  diag: { code: string; message: string; loc: { file: string; start: number } },
  node: ts.Node,
): string {
  const source = ts.getSourceFileOfNode(node);
  const pos = ts.getLineAndCharacterOfPosition(source, diag.loc.start);
  return `${diag.message} [${diag.code} at ${diag.loc.file}:${pos.line + 1}]`;
}
