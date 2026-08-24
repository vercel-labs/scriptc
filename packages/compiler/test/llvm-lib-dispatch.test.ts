import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import {
  DYN,
  NETSOCKET_T,
  STRING,
  VOID,
  type IrExpr,
  type IrLibFn,
  type IrModule,
  type IrType,
} from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "llvm-lib-dispatch.ts", start: 0, end: 0 };

const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const dyn = (): IrExpr => ({ kind: "dynFrom", value: str("value"), type: DYN, loc });

function libCallModule(fn: IrLibFn, args: IrExpr[], type: IrType): IrModule {
  return {
    irVersion: 6,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{
      name: "__main",
      params: [],
      returnType: VOID,
      locals: [],
      body: [{
        kind: "exprStmt",
        expr: { kind: "libCall", fn, args, type, loc },
        loc,
      }],
      loc,
    }],
  };
}

test.each([
  ["fs.mkdtempChk", "scr_fs_mkdtemp_chk", 2],
  ["fs.readFileChk", "scr_fs_read_file_chk", 3],
  ["fs.opendirChk", "scr_fs_opendir_chk", 2],
  ["fs.watchFileChk", "scr_fs_watch_file_chk", 2],
  ["fs.lchmodChk", "scr_fs_lchmod_chk", 3],
  ["fs.readChk", "scr_fs_read_chk", 5],
  ["fs.streamOptsChk", "scr_fs_stream_opts_chk", 2],
] as const)("LLVM routes %s through filesystem validation emission", (fn, sym, dynArgs) => {
  const mod = libCallModule(fn, [...Array.from({ length: dynArgs }, dyn), str("fence")], VOID);
  expect(validateModule(mod)).toEqual([]);
  expect(emitLlvmModule(mod)).toContain(`call void @${sym}(`);
});

test("LLVM routes net.connectOptsChk through network validation emission", () => {
  const mod = libCallModule("net.connectOptsChk", [dyn(), str("fence")], NETSOCKET_T);
  expect(validateModule(mod)).toEqual([]);
  expect(emitLlvmModule(mod)).toContain("call void @scr_net_connect_opts_chk(");
});
