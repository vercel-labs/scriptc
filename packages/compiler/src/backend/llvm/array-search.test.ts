import { expect, test } from "vitest";
import {
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "array-search.ts", start: 0, end: 0 };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

/** A module whose function `find` returns `a.method(v)` for an array `a`
 * of `elem`. */
function module(elem: IrType, method: "indexOf" | "includes"): IrModule {
  const arr = arrayOf(elem);
  const search: IrExpr = {
    kind: "arrIntrinsic",
    method,
    receiver: ref("a", arr),
    args: [ref("v", elem)],
    type: method === "includes" ? { kind: "bool" } : F64,
    loc,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "find",
        params: [
          { name: "a", localId: "a", type: arr },
          { name: "v", localId: "v", type: elem },
        ],
        returnType: search.type,
        locals: [
          { id: "a", name: "a", type: arr, mutable: false },
          { id: "v", name: "v", type: elem, mutable: false },
        ],
        body: [{ kind: "return", value: search, loc }],
        loc,
      },
    ],
  };
}

function helper(llvm: string, name: string): string {
  return new RegExp(`^define internal double @${name}\\([^]*?^}`, "m").exec(llvm)![0];
}

test.each([32, 64] as const)("string arrays search inline (%i-bit)", (bits) => {
  const sz = bits === 64 ? "i64" : "i32";
  const llvm = emitLlvmModule(module(STRING, "indexOf"), { pointerBits: bits });
  expect(llvm).toMatch(/call double @sc_arr_index_of_str\(ptr .*, ptr .*\)/);
  const fn = helper(llvm, "sc_arr_index_of_str");
  // Dense arrays only (filled == len); everything else is the runtime search.
  expect(fn).toMatch(new RegExp(`icmp eq ${sz} %f, %len`));
  expect(fn).toContain("call double @scr_arr_index_of_ref(ptr %a, ptr %v)");
  // Pointer identity, the length, then up to 16 bytes as words; longer
  // strings compare in the runtime.
  expect(fn).toContain("icmp eq ptr %s, %v");
  expect(fn).toMatch(/load i64, ptr %sap, align 1/);
  expect(fn).toContain("call zeroext i1 @scr_str_eq(ptr %s, ptr %v)");
});

test.each([32, 64] as const)("reference arrays compare slots, four per step (%i-bit)", (bits) => {
  const llvm = emitLlvmModule(module(arrayOf(F64), "includes"), { pointerBits: bits });
  expect(llvm).toMatch(/call double @sc_arr_index_of_ptr\(ptr .*, ptr .*\)/);
  expect(llvm).toMatch(/fcmp oge double %.*, 0\.0/);
  const fn = helper(llvm, "sc_arr_index_of_ptr");
  expect(fn.match(/icmp eq i64 %qs\d, %needle/g)).toHaveLength(4);
  expect(fn).toContain("icmp eq i64 %s, %needle");
  expect(llvm).not.toContain("sc_arr_index_of_str");
});

test("number arrays keep the runtime search", () => {
  const llvm = emitLlvmModule(module(F64, "indexOf"), { pointerBits: 64 });
  expect(llvm).toContain("call double @scr_arr_index_of_f64(");
  expect(llvm).not.toContain("sc_arr_index_of_");
});
