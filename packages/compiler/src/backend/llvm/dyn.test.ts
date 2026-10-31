import { expect, test } from "vitest";
import { DYN, F64, JSVAL, STRING, VOID, type IrModule, type IrType } from "../../ir/ir.js";
import { LlEmitter } from "./emitter.js";
import { JS_BITS } from "./jsval-encoding.js";

const loc = { file: "callback-result.ts", start: 0, end: 0 };
const module: IrModule = {
  irVersion: 17,
  sourceFile: loc.file,
  entry: "main",
  workers: true,
  functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
};

function returnPaths(emitter: LlEmitter, name: string, call: RegExp, hint: string) {
  const definitions = emitter.dyn.defs.join("\n");
  const body = new RegExp(`^define [^\\n]*@${name}\\([^]*?^}`, "m").exec(definitions)![0];
  const value = call.exec(body)![1]!;
  const branch = new RegExp(
    `br i1 %\\w+, label %(${hint}\\.u\\d+), label %(${hint}\\.k\\d+)`,
  ).exec(body)!;
  const unwind = body.split(branch[1] + ":\n")[1]!.split(branch[2] + ":\n")[0]!;
  const success = body.split(branch[2] + ":\n")[1]!;
  expect(body.indexOf(value + " = call")).toBeLessThan(body.indexOf(branch[0]));
  return { value, unwind, success };
}

function resultReleases(block: string, value: string): string[] {
  return [...block.matchAll(/call void @([^ (]+)\(ptr (%\w+)\)/g)]
    .filter((match) => match[2] === value && match[1]!.includes("release"))
    .map((match) => match[1]!);
}

function expectRelease(block: string, value: string, type: IrType) {
  const names = resultReleases(block, value);
  const stem = type.kind === "dyn" ? "dyn" : type.kind === "jsval" ? "js" : "str";
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(new RegExp(`^(?:scr_${stem}_release|sc_rc_release_${stem})$`));
  expect(block.indexOf("call void")).toBeLessThan(block.indexOf("ret "));
}

for (const type of [DYN, STRING, F64]) {
  test(`dynamic call thunk owns ${type.kind} results across pending checks`, () => {
    for (const inlineRc of [undefined, "release"] as const) {
      const emitter = new LlEmitter(module, { inlineRc });
      const name = emitter.dyn.dynFuncThunkHelper({ kind: "func", params: [STRING], ret: type });
      const paths = returnPaths(emitter, name, /(%\w+) = call (?:ptr|double) %\w+\(/, "dfkr");
      if (type.kind === "f64") expect(resultReleases(paths.unwind, paths.value)).toEqual([]);
      else expectRelease(paths.unwind, paths.value, type);
      expect(paths.unwind).toContain("ret ptr null");
      if (type.kind === "string") expectRelease(paths.success, paths.value, type);
      else expect(resultReleases(paths.success, paths.value)).toEqual([]);
      if (type.kind === "dyn") expect(paths.success).toContain(`ret ptr ${paths.value}`);
    }
  });
}

for (const type of [DYN, JSVAL, STRING, F64]) {
  test(`JavaScript entry owns ${type.kind} results across pending checks`, () => {
    for (const inlineRc of [undefined, "release"] as const) {
      const emitter = new LlEmitter(module, { inlineRc });
      const name = emitter.dyn.jsEntryThunk("callback", [JSVAL, DYN], type);
      const paths = returnPaths(emitter, name, /(%\w+) = call (?:ptr|double) @callback\(/, "jtr");
      if (type.kind === "f64") expect(resultReleases(paths.unwind, paths.value)).toEqual([]);
      else expectRelease(paths.unwind, paths.value, type);
      expect(paths.unwind).toContain(`ret ptr inttoptr (i64 ${JS_BITS.undefined} to ptr)`);
      if (type.kind === "string") expectRelease(paths.success, paths.value, type);
      else expect(resultReleases(paths.success, paths.value)).toEqual([]);
      if (type.kind === "jsval") expect(paths.success).toContain(`ret ptr ${paths.value}`);
    }
  });
}

for (const type of [DYN, STRING, F64, VOID]) {
  test(`typed callback adapter owns its dynamic result before returning ${type.kind}`, () => {
    for (const inlineRc of [undefined, "release"] as const) {
      const emitter = new LlEmitter(module, { inlineRc });
      const name = emitter.dyn.dynFuncAdapterHelper({ kind: "func", params: [STRING], ret: type });
      const paths = returnPaths(emitter, name, /(%\w+) = call ptr @scr_dyn_call\(/, "dfa");
      expectRelease(paths.unwind, paths.value, DYN);
      if (type.kind === "dyn") {
        expect(resultReleases(paths.success, paths.value)).toEqual([]);
        expect(paths.success).toContain(`ret ptr ${paths.value}`);
      } else expectRelease(paths.success, paths.value, DYN);
      if (type.kind === "void") expect(paths.unwind).toContain("ret void");
      else if (type.kind !== "f64") expect(paths.unwind).toContain("ret ptr null");
    }
  });
}
