import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { moduleRuntimeFeatures } from "../../ir/runtime-features.js";
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
    irVersion: 17,
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
  return /^define internal [^\n]*@sc_bf_report(?:\.i32)?\([^]*?^}/m.exec(emitLlvmModule(mod))![0];
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

/** The module of `function take(value: unknown) { <conversion of value to the target>; }`
 * and the LLVM of `take`. The target is number[], or the record `{ x: number }`. */
function conversionModule(
  conversion: (value: IrExpr, type: IrType) => IrExpr,
  target: "array" | "record" = "array",
): {
  mod: IrModule;
  llvm: string;
  body: string;
} {
  const numbers: IrType = target === "array" ? arrayOf(F64) : { kind: "record", shapeId: "cell" };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    functions: [
      { name: "main", loc, params: [], locals: [], returnType: VOID, body: [] },
      {
        name: "take",
        loc,
        params: [{ name: "value", localId: "value", type: DYN }],
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr: conversion(ref("value", DYN), numbers), loc }],
      },
    ],
  };
  expect(validateModule(mod)).toEqual([]);
  const llvm = emitLlvmModule(mod);
  return { mod, llvm, body: /^define internal [^\n]*@sc_bf_take\([^]*?^}/m.exec(llvm)![0] };
}

test("a typed slot's conversion adopts its source only while the node carries the flag", () => {
  // The flag on the checked conversion asks for one object: after the check,
  // the source becomes a live capsule of the array built from it.
  const shared = conversionModule((value, type) => ({
    kind: "dynCheck",
    value,
    shared: true,
    type,
    loc,
  }));
  expect(moduleRuntimeFeatures(shared.mod).declAdopt).toBe(true);
  // A consumer that rebuilds the node from its other fields drops the flag
  // and gets the plain checked copy: the same check, no adoption, and the
  // adoption unit is not linked.
  const copied = conversionModule((value, type) => ({ kind: "dynCheck", value, type, loc }));
  expect(moduleRuntimeFeatures(copied.mod).declAdopt).toBe(false);
  expect(copied.llvm).not.toContain("scr_dyn_adopt_whole");
  expect(copied.body.match(/call ptr @sc_dc_\d+\(/g)).toHaveLength(1);

  // The adoption is out of line: the flagged site is the plain site's text
  // with another callee.
  const callee = /call ptr @(sc_dc_\w+)\(/;
  const plain = callee.exec(copied.body)![1]!;
  const adopting = callee.exec(shared.body)![1]!;
  expect(shared.body.replace(`@${adopting}(`, `@${plain}(`)).toBe(copied.body);
  // The adopting helper is named after its plain helper and takes no number
  // of the `sc_dc_<n>` sequence: the numbered helpers of the flagged module
  // are the unflagged module's, name for name.
  expect(adopting).toMatch(new RegExp(`^${plain}_adopt(_held)?$`));
  const numbered = (llvm: string): string[] =>
    [...llvm.matchAll(/^define internal [^\n]*@(sc_dc_\d+)\(/gm)].map((m) => m[1]!);
  expect(numbered(shared.llvm)).toEqual(numbered(copied.llvm));

  // The callee is never inlined into the site. A value that is not a plain
  // object or array goes on to the plain helper in a tail call; a plain one
  // is checked, and adopted only where the check left no error pending.
  const helper = helperBody(shared.llvm, adopting);
  expect(helper).toMatch(/^define internal ptr @sc_dc_\w+\(ptr %d, ptr %path\) noinline /);
  const steps = [
    /icmp eq i32 %t\d+, 4$/m,
    /icmp eq i32 %t\d+, 5$/m,
    new RegExp(`= tail call ptr @${plain}\\(ptr %d, ptr %path\\)`),
    new RegExp(`= call ptr @${plain}\\(ptr %d, ptr %path\\)`),
    /call zeroext i1 @scr_exc_pending\(\)/,
    /call void @scr_dyn_adopt_whole\(ptr %d, ptr /,
  ].map((step) => helper.search(step));
  expect(steps.every((at) => at >= 0)).toBe(true);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
  expect(helper.match(/call void @scr_dyn_adopt_whole\(/g)).toHaveLength(1);
});

test("a record's typed slot hands the type's own capsule out as the plain site does", () => {
  const flagged = conversionModule(
    (value, type) => ({ kind: "dynCheck", value, shared: true, type, loc }),
    "record",
  );
  const copied = conversionModule(
    (value, type) => ({ kind: "dynCheck", value, type, loc }),
    "record",
  );
  const callees = (body: string): string[] =>
    [...body.matchAll(/call ptr @(sc_dc_\w+)\(/g)].map((m) => m[1]!);
  // One helper call in each: the path of every value but the type's own
  // capsule, which hands its record out with no call (the address compare
  // of its key) and never reaches the adoption.
  const [plain] = callees(copied.body);
  const [adopting] = callees(flagged.body);
  expect(callees(copied.body)).toHaveLength(1);
  expect(callees(flagged.body)).toHaveLength(1);
  expect(adopting).toMatch(new RegExp(`^${plain}_adopt(_held)?$`));
  expect(copied.body).toContain("typed_ref.type_key");
  expect(copied.body).toMatch(
    /= phi ptr \[ %t\d+, %dc\.own\.hit\d+ \], \[ %t\d+, %dc\.own\.other\d+ \]$/m,
  );
  // The flagged site is the plain site's text with the adopting helper as
  // the callee: the function is the same size, and whether it is inlined
  // into its callers is decided as without the flag.
  expect(flagged.body).not.toContain("scr_dyn_adopt_whole");
  expect(flagged.body.replace(`@${adopting}(`, `@${plain}(`)).toBe(copied.body);
  const helper = helperBody(flagged.llvm, adopting!);
  expect(helper).toMatch(/^define internal ptr @sc_dc_\w+\(ptr %d, ptr %path\) noinline /);
  expect(helper).toContain(`tail call ptr @${plain}(ptr %d, ptr %path)`);
  expect(helper.match(/call void @scr_dyn_adopt_whole\(/g)).toHaveLength(1);
});

/** The definition of one conversion helper in a module's LLVM. */
function helperBody(llvm: string, name: string): string {
  return new RegExp(`^define internal ptr @${name}\\([^]*?^}`, "m").exec(llvm)![0];
}
