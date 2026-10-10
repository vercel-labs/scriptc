import { expect, test } from "vitest";
import { foldConstantGlobals } from "./constant-globals.js";
import { F64, VOID, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";

const loc = { file: "constant-globals.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const assign = (localId: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "assign",
  localId,
  value,
});
const ret = (value: IrExpr): IrStmt => ({ loc, kind: "return", value });
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  loc,
  name,
  params: [],
  locals: [],
  returnType: name === "%init" ? VOID : F64,
  body,
});
const global = (id: string, extra: object = {}) => ({
  id,
  name: id,
  type: F64,
  mutable: false,
  ...extra,
});

test("immutable globals stored once with a literal read as that literal", () => {
  const mod: IrModule = {
    irVersion: 15,
    sourceFile: "constant-globals.ts",
    entry: "%init",
    functions: [
      fn("%init", [
        assign("%g.DOT", num(46)),
        assign("%g.LATE", num(7)),
        assign("%g.TWICE", num(1)),
        assign("%g.TWICE", num(2)),
        assign("%g.MUT", num(3)),
      ]),
      fn("read", [
        ret({
          loc,
          kind: "bin",
          op: "+",
          left: ref("%g.DOT"),
          right: {
            loc,
            kind: "bin",
            op: "+",
            left: ref("%g.LATE"),
            right: {
              loc,
              kind: "bin",
              op: "+",
              left: ref("%g.TWICE"),
              right: ref("%g.MUT"),
              type: F64,
            },
            type: F64,
          },
          type: F64,
        }),
      ]),
    ],
    classes: [],
    records: [],
    unions: [],
    globals: [
      global("%g.DOT"),
      global("%g.LATE", { initFlag: "%g.LATE.initialized" }),
      global("%g.TWICE"),
      global("%g.MUT", { mutable: true }),
    ],
  };
  const folded = foldConstantGlobals(mod);
  const reads: string[] = [];
  const walk = (e: IrExpr): void => {
    if (e.kind === "varRef") reads.push(e.localId);
    else if (e.kind === "numLit") reads.push(String(e.value));
    else if (e.kind === "bin") {
      walk(e.left);
      walk(e.right);
    }
  };
  const body = folded.functions.find((f) => f.name === "read")!.body[0]!;
  if (body.kind === "return" && body.value) walk(body.value);
  expect(reads).toEqual(["46", "%g.LATE", "%g.TWICE", "%g.MUT"]);
  // The initializer keeps its store; the input module is not modified.
  expect(folded.functions[0]).toBe(mod.functions[0]);
  expect(mod.functions[1]!.body[0]).not.toBe(body);
});
