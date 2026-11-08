import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { shareIslandProcessState } from "./island-process-state.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "main.mjs", start: 0, end: 1 };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});
const calls = (): (IrExpr & { kind: "libCall" })[] => [
  {
    kind: "libCall",
    fn: "process.setExitCode",
    args: [{ kind: "numLit", value: 3, type: F64, loc }],
    type: VOID,
    loc,
  },
  {
    kind: "libCall",
    fn: "process.setExitCodeTracked",
    args: [{ kind: "numLit", value: 4, type: F64, loc }],
    type: VOID,
    loc,
  },
  { kind: "libCall", fn: "process.currentExitCode", args: [], type: F64, loc },
  { kind: "libCall", fn: "process.hasExitCode", args: [], type: BOOL, loc },
  { kind: "libCall", fn: "process.cwd", args: [], type: { kind: "string" }, loc },
  {
    kind: "libCall",
    fn: "process.chdir",
    args: [{ kind: "strLit", value: "..", type: { kind: "string" }, loc }],
    type: VOID,
    loc,
  },
];
const body = (exprs: IrExpr[]): IrStmt[] => exprs.map((expr) => ({ kind: "exprStmt", expr, loc }));

test("a program with Node islands reads and writes process.exitCode through the island unit", () => {
  const exprs = calls();
  shareIslandProcessState({ usesNodeIsland: true } as unknown as Lowerer, [
    fn(ENTRY_NAME, body(exprs)),
  ]);
  expect(exprs.map((e) => e.fn)).toEqual([
    "nodeIsland.setExitCode",
    "nodeIsland.setExitCode",
    "nodeIsland.exitCode",
    "nodeIsland.hasExitCode",
    "process.cwd",
    "nodeIsland.chdir",
  ]);
});

test("a program without Node islands keeps the runtime's exit-code calls", () => {
  const exprs = calls();
  shareIslandProcessState({ usesNodeIsland: false } as unknown as Lowerer, [
    fn(ENTRY_NAME, body(exprs)),
  ]);
  expect(exprs.map((e) => e.fn)).toEqual([
    "process.setExitCode",
    "process.setExitCodeTracked",
    "process.currentExitCode",
    "process.hasExitCode",
    "process.cwd",
    "process.chdir",
  ]);
});
