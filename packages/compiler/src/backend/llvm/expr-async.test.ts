import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "console.ts", start: 0, end: 1 };
const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string, type = STRING): IrExpr => ({ kind: "varRef", localId, type, loc });
const str = (operand: IrExpr): IrExpr => ({ kind: "toString", operand, type: STRING, loc });
const concat = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "strConcat",
  left,
  right,
  type: STRING,
  loc,
});

function logBody(name: "console.log" | "console.error", args: IrExpr[]): string {
  const mod: IrModule = {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", loc, params: [], locals: [], returnType: VOID, body: [] },
      {
        name: "report",
        loc,
        params: [
          { name: "label", localId: "label", type: STRING },
          { name: "n", localId: "n", type: F64 },
          { name: "ok", localId: "ok", type: BOOL },
        ],
        locals: [
          { id: "label", name: "label", type: STRING, mutable: false },
          { id: "n", name: "n", type: F64, mutable: false },
          { id: "ok", name: "ok", type: BOOL, mutable: false },
        ],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr: { kind: "intrinsic", name, args, type: VOID, loc }, loc }],
      },
    ],
  };
  expect(validateModule(mod)).toEqual([]);
  return /^define internal [^\n]*@sc_bf_report\([^]*?^}/m.exec(emitLlvmModule(mod))![0];
}

test("a template-literal argument passes its parts without joining them", () => {
  // console.log(`${label} n=${n} ok=${ok}`, n)
  const template = concat(
    concat(concat(concat(ref("label"), text(" n=")), str(ref("n", F64))), text(" ok=")),
    str(ref("ok", BOOL)),
  );
  const body = logBody("console.log", [template, ref("n", F64)]);
  expect(body).toContain("call void @scr_console_log_parts(i64 6, ptr %logargs)");
  expect(body).not.toContain("@scr_str_concat");
  expect(body).not.toContain("@scr_f64_to_scrstr");
  expect(body).not.toContain("@scr_bool_to_scrstr");
  // Tags: label (string), " n=" (glued string), n (glued String() number),
  // " ok=" (glued string), ok (glued bool), then n as its own argument.
  const tags = [...body.matchAll(/store i32 (\d+), ptr/g)].map((m) => Number(m[1]));
  expect(tags).toEqual([1, 0x101, 0x103, 0x101, 0x102, 0]);
});

test("plain arguments keep the original entry points", () => {
  const body = logBody("console.error", [ref("label"), ref("n", F64), ref("ok", BOOL)]);
  expect(body).toContain("call void @scr_console_error(i64 3, ptr %logargs)");
  expect(body).not.toContain("_parts");
});
