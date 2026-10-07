import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import {
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "string-accumulation.ts", start: 0, end: 0 };
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
const selfConcat = (localId: string, right: IrExpr = str("+")): IrExpr => ({
  kind: "strConcat",
  left: ref(localId),
  right,
  type: STRING,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});

function functionWithLocal(name: string, local: IrLocal, body: IrStmt[]): IrFunction {
  return { name, params: [], returnType: VOID, locals: [local], body, loc };
}

function fixture(): IrModule {
  const plain: IrLocal = { id: "acc", name: "acc", type: STRING, mutable: true };
  const boxed: IrLocal = { id: "boxed", name: "boxed", type: STRING, mutable: true, boxed: true };
  const functions: IrFunction[] = [
    functionWithLocal("plain", plain, [
      { kind: "varDecl", localId: "acc", init: str("seed"), loc },
      assign("acc", selfConcat("acc")),
    ]),
    functionWithLocal("assignExpr", plain, [
      { kind: "varDecl", localId: "acc", init: str("seed"), loc },
      {
        kind: "exprStmt",
        expr: { kind: "assignExpr", localId: "acc", value: selfConcat("acc"), type: STRING, loc },
        loc,
      },
    ]),
    functionWithLocal("suffixReassign", plain, [
      { kind: "varDecl", localId: "acc", init: str("seed"), loc },
      assign(
        "acc",
        selfConcat("acc", {
          kind: "assignExpr",
          localId: "acc",
          value: str("replacement"),
          type: STRING,
          loc,
        }),
      ),
    ]),
    functionWithLocal("boxed", boxed, [
      { kind: "varDecl", localId: "boxed", init: str("seed"), loc },
      assign("boxed", selfConcat("boxed")),
    ]),
    functionWithLocal("negative", plain, [
      { kind: "varDecl", localId: "acc", init: str("seed"), loc },
      assign("acc", { kind: "strConcat", left: ref("other"), right: str("+"), type: STRING, loc }),
    ]),
    {
      name: "__main",
      params: [],
      returnType: VOID,
      locals: [],
      body: [assign("%g.e.acc", str("global")), assign("%g.e.acc", selfConcat("%g.e.acc"))],
      loc,
    },
  ];
  // The negative function needs a real, distinct left binding.
  functions
    .find((fn) => fn.name === "negative")!
    .locals.push({ id: "other", name: "other", type: STRING, mutable: false });
  functions
    .find((fn) => fn.name === "negative")!
    .body.splice(1, 0, { kind: "varDecl", localId: "other", init: str("other"), loc });
  return {
    irVersion: 14,
    sourceFile: loc.file,
    entry: "__main",
    globals: [{ id: "%g.e.acc", name: "globalAccumulator", type: STRING, mutable: true }],
    functions,
  };
}

function expectInOrder(text: string, fragments: readonly string[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const found = text.indexOf(fragment, offset);
    expect(found, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThanOrEqual(offset);
    offset = found + fragment.length;
  }
}

test("LLVM hands off canonical string self-concats after suffix evaluation", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);

  const llvm = emitLlvmModule(mod);

  // Plain local: retained snapshot, suffix, detach/release, concat, move.
  expectInOrder(llvm, [
    "call ptr @scr_str_retain_v(ptr %t",
    "load ptr, ptr %sc_l_acc",
    "store ptr null, ptr %sc_l_acc",
    "call void @scr_str_release",
    "call ptr @scr_str_concat",
    "store ptr %",
  ]);

  // Module globals use the same plain-slot handoff; boxes use set_ref(NULL).

  expect(llvm).toContain("store ptr null, ptr @sc_g_e_acc");

  expect(llvm).toContain("call void @scr_box_set_ref(ptr %");

  // The expression form leaves its own result live and gives the binding a
  // retained sibling. A suffix assignment changes the binding before the
  // final detach, so the detach must occur after its replacement store.

  const suffixBody = llvm.match(/define internal void @sc_f_suffixReassign\([^]*?\n\}/)?.[0];
  expect(suffixBody).toBeDefined();
  expectInOrder(suffixBody!, [
    "call ptr @scr_str_retain_v",
    "store ptr @sc_lit_",
    "ptr %sc_l_acc",
    "load ptr, ptr %sc_l_acc",
    "store ptr null, ptr %sc_l_acc",
    "call void @scr_str_release",
    "call ptr @scr_str_concat",
  ]);

  // Concatenating another binding keeps the destination live until concat.
  const negative = llvm.match(/define internal void @sc_f_negative\([^]*?\n\}/)?.[0];
  expect(negative).toBeDefined();
  expect(negative).toContain("call ptr @scr_str_concat");
  const concat = negative!.indexOf("call ptr @scr_str_concat");
  const initialized = negative!.match(/store ptr (?:%\w+|@sc_lit_\d+), ptr %sc_l_acc/);
  expect(initialized).not.toBeNull();
  expect(negative!.slice(initialized!.index!, concat)).not.toContain(
    "store ptr null, ptr %sc_l_acc",
  );
});
