import { expect, test } from "vitest";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { STRING, VOID, type IrExpr, type IrFunction, type IrLocal, type IrModule, type IrStmt } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "string-accumulation.ts", start: 0, end: 0 };
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
const selfConcat = (localId: string, right: IrExpr = str("+")): IrExpr => ({
  kind: "strConcat", left: ref(localId), right, type: STRING, loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({ kind: "assign", localId, value, loc });

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
      { kind: "exprStmt", expr: { kind: "assignExpr", localId: "acc", value: selfConcat("acc"), type: STRING, loc }, loc },
    ]),
    functionWithLocal("suffixReassign", plain, [
      { kind: "varDecl", localId: "acc", init: str("seed"), loc },
      assign("acc", selfConcat("acc", {
        kind: "assignExpr", localId: "acc", value: str("replacement"), type: STRING, loc,
      })),
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
      name: "__main", params: [], returnType: VOID, locals: [],
      body: [
        assign("%g.e.acc", str("global")),
        assign("%g.e.acc", selfConcat("%g.e.acc")),
      ], loc,
    },
  ];
  // The negative function needs a real, distinct left binding.
  functions.find((fn) => fn.name === "negative")!.locals.push(
    { id: "other", name: "other", type: STRING, mutable: false },
  );
  functions.find((fn) => fn.name === "negative")!.body.splice(1, 0,
    { kind: "varDecl", localId: "other", init: str("other"), loc },
  );
  return {
    irVersion: 6,
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

test("C and LLVM hand off canonical string self-concats after suffix evaluation", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const c = emitCModule(mod);
  const llvm = emitLlvmModule(mod);

  // Plain local: retained snapshot, suffix, detach/release, concat, move.
  expectInOrder(c, [
    "scr_str_retain(sc_l_acc)",
    "ScrStr *sc_t", "= sc_l_acc;", "sc_l_acc = NULL;", "scr_str_release(sc_t",
    "scr_str_concat(sc_t", "sc_l_acc = sc_t",
  ]);
  expectInOrder(llvm, [
    "call ptr @scr_str_retain_v(ptr %t",
    "load ptr, ptr %sc_l_acc", "store ptr null, ptr %sc_l_acc",
    "call void @scr_str_release", "call ptr @scr_str_concat", "store ptr %",
  ]);

  // Module globals use the same plain-slot handoff; boxes use set_ref(NULL).
  expect(c).toContain("sc_g_e_acc = NULL;");
  expect(llvm).toContain("store ptr null, ptr @sc_g_e_acc");
  expect(c).toContain("scr_box_set_ref(sc_l_boxed, NULL);");
  expect(llvm).toContain("call void @scr_box_set_ref(ptr %");

  // The expression form leaves its own result live and gives the binding a
  // retained sibling. A suffix assignment changes the binding before the
  // final detach, so the detach must occur after its replacement store.
  expect(c).toMatch(/scr_str_concat\(sc_t\d+, sc_t\d+\);\n\s*scr_box_set_ref|scr_str_concat\(sc_t\d+, sc_t\d+\);\n\s*sc_l_acc = scr_str_retain/);
  const replacementStore = c.indexOf("sc_l_acc = scr_str_retain(sc_t");
  const postSuffixDetach = c.indexOf("sc_l_acc = NULL;", replacementStore);
  expect(replacementStore).toBeGreaterThanOrEqual(0);
  expect(postSuffixDetach).toBeGreaterThan(replacementStore);

  // A different left binding keeps the generic concat lowering: it never
  // clears the destination before invoking concat.
  const negativeStart = c.indexOf("static void sc_f_negative(void) {");
  const negativeEnd = c.indexOf("}", negativeStart);
  const negative = c.slice(negativeStart, negativeEnd);
  expect(negativeStart).toBeGreaterThanOrEqual(0);
  expect(negative).toContain("scr_str_concat(");
  expect(negative).not.toMatch(/sc_l_acc = NULL;\n\s*scr_str_release\(sc_t\d+\);\n\s*ScrStr \*sc_t\d+ = scr_str_concat/);
});
