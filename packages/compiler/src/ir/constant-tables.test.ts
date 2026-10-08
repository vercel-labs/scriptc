import { expect, test } from "vitest";
import { findConstantNumericTables } from "./constant-tables.js";
import { arrayOf, F64, funcOf, VOID, type IrExpr, type IrModule, type IrStmt } from "./ir.js";
import { validateModule } from "./validate.js";

const loc = { file: "constant-tables.ts", start: 0, end: 0 };
const type = arrayOf(F64);
const id = "%g.table";
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (): IrExpr => ({ kind: "varRef", localId: id, type, loc });
const read = (index = num(0)): IrExpr => ({
  kind: "arrIntrinsic",
  method: "getNumber",
  receiver: ref(),
  args: [index],
  type: F64,
  loc,
});
const expr = (value: IrExpr): IrStmt => ({ kind: "exprStmt", expr: value, loc });

function fixture(): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    globals: [{ id, name: "table", type, mutable: false }],
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [
          {
            kind: "assign",
            localId: id,
            value: { kind: "arrayLit", elems: [num(2), num(-0), num(Infinity)], type, loc },
            loc,
          },
          expr(read()),
        ],
        loc,
      },
    ],
  };
}

test("finds literal tables without mutating or deleting their original initialization", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const before = structuredClone(mod);
  expect(findConstantNumericTables(mod).get(id)?.values).toEqual([2, -0, Infinity]);
  expect(mod).toEqual(before);
});

test.each([
  "alias",
  "element",
  "length",
  "argument",
  "return",
  "reassign",
  "index mutation",
  "capture",
  "callback",
])("refuses %s uses anywhere in the module", (use) => {
  const mod = fixture();
  const body = mod.functions[0]!.body;
  const mutation: IrStmt = { kind: "arraySet", arr: ref(), index: num(0), value: num(9), loc };
  if (use === "alias") {
    mod.functions[0]!.locals.push({ id: "alias", name: "alias", type, mutable: false });
    body.push({ kind: "varDecl", localId: "alias", init: ref(), loc });
  } else if (use === "element") body.push(mutation);
  else if (use === "length") body.push({ kind: "arraySetLength", arr: ref(), length: num(0), loc });
  else if (use === "argument")
    body.push(expr({ kind: "call", callee: "external", args: [ref()], type: VOID, loc }));
  else if (use === "return") body.push({ kind: "return", value: ref(), loc });
  else if (use === "reassign") body.push(body[0]!);
  else if (use === "index mutation")
    body.push(
      expr(
        read({ kind: "arrIntrinsic", method: "pop", receiver: ref(), args: [], type: F64, loc }),
      ),
    );
  else if (use === "capture")
    body.push(
      expr({ kind: "closure", fnName: "callback", captures: [id], type: funcOf([], VOID), loc }),
    );
  else
    mod.functions.push({
      name: "laterCallback",
      params: [],
      returnType: VOID,
      locals: [],
      body: [mutation],
      loc,
    });
  expect(findConstantNumericTables(mod).size).toBe(0);
});

test("permits primitive reads and length queries, including nested numeric indices", () => {
  const mod = fixture();
  mod.functions[0]!.body.push(
    expr(read(read(num(0)))),
    expr({ kind: "arrIntrinsic", method: "length", receiver: ref(), args: [], type: F64, loc }),
    expr({ kind: "arrayGet", arr: ref(), index: num(1), type: F64, loc }),
  );
  expect(validateModule(mod)).toEqual([]);
  expect(findConstantNumericTables(mod).size).toBe(1);
});

test.each(["mutable", "spread", "effectful", "empty", "large", "missing initializer"])(
  "leaves %s tables on the generic path",
  (reason) => {
    const mod = fixture();
    const init = (mod.functions[0]!.body[0] as IrStmt & { kind: "assign" }).value as IrExpr & {
      kind: "arrayLit";
    };
    if (reason === "mutable") mod.globals![0]!.mutable = true;
    else if (reason === "spread") init.spreads = [0];
    else if (reason === "effectful")
      init.elems[0] = { kind: "call", callee: "effect", args: [], type: F64, loc };
    else if (reason === "empty") init.elems = [];
    else if (reason === "large") init.elems = Array.from({ length: 257 }, () => num(1));
    else mod.functions[0]!.body.shift();
    expect(findConstantNumericTables(mod).size).toBe(0);
  },
);
