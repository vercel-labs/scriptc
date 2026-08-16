import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { emitModule } from "../src/backend/emission/emitter.js";
import { compileC } from "../src/backend/cc.js";
import { validateModule } from "../src/ir/validate.js";
import { fibModule } from "./fixtures/fib-ir.js";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrModule } from "../src/ir/nodes.js";

const execFileAsync = promisify(execFile);

async function emitCompileRun(mod: IrModule, sanitize = true): Promise<string> {
  expect(validateModule(mod)).toEqual([]);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-emit-"));
  const cPath = join(dir, "program.c");
  await writeFile(cPath, emitModule(mod));
  const outPath = join(dir, "program");
  await compileC({ cPath, outPath, sanitize });
  const { stdout } = await execFileAsync(outPath);
  return stdout;
}

test("hand-built fib IR compiles and prints 55", async () => {
  expect(await emitCompileRun(fibModule)).toBe("55\n");
});

test("strings: literals, concat in a loop, toString, RC-clean under audit", async () => {
  const loc = { file: "s.ts", start: 0, end: 0 };
  const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  // let acc = "x"; let i = 0;
  // while (i < 3) { acc = acc + ("-" + i); i = i + 1; }
  // console.log(acc, acc === "x-0-1-2", "α∂" < "β");
  const mod: IrModule = {
    irVersion: 4,
    sourceFile: "s.ts",
    entry: "__main",
    functions: [
      {
        name: "__main",
        params: [],
        returnType: VOID,
        locals: [
          { id: "acc.0", name: "acc", type: STRING, mutable: true },
          { id: "i.0", name: "i", type: F64, mutable: true },
        ],
        body: [
          { kind: "varDecl", localId: "acc.0", init: str("x"), loc },
          { kind: "varDecl", localId: "i.0", init: num(0), loc },
          {
            kind: "while",
            cond: {
              kind: "bin", op: "<",
              left: { kind: "varRef", localId: "i.0", type: F64, loc },
              right: num(3), type: BOOL, loc,
            },
            body: [
              {
                kind: "assign",
                localId: "acc.0",
                value: {
                  kind: "strConcat",
                  left: { kind: "varRef", localId: "acc.0", type: STRING, loc },
                  right: {
                    kind: "strConcat",
                    left: str("-"),
                    right: { kind: "toString", operand: { kind: "varRef", localId: "i.0", type: F64, loc }, type: STRING, loc },
                    type: STRING, loc,
                  },
                  type: STRING, loc,
                },
                loc,
              },
              {
                kind: "assign",
                localId: "i.0",
                value: { kind: "bin", op: "+", left: { kind: "varRef", localId: "i.0", type: F64, loc }, right: num(1), type: F64, loc },
                loc,
              },
            ],
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "intrinsic",
              name: "console.log",
              args: [
                { kind: "varRef", localId: "acc.0", type: STRING, loc },
                { kind: "strEq", negated: false, left: { kind: "varRef", localId: "acc.0", type: STRING, loc }, right: str("x-0-1-2"), type: BOOL, loc },
                { kind: "strCmp", op: "<", left: str("α∂"), right: str("β"), type: BOOL, loc },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
  expect(await emitCompileRun(mod)).toBe("x-0-1-2 true true\n");
});

test("short-circuit: right operand of && only evaluates when left is true", async () => {
  const loc = { file: "l.ts", start: 0, end: 0 };
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  // function sideEffect(): boolean { console.log("evaluated"); return true; }
  // if (false && sideEffect()) {} ; if (true || sideEffect()) {}
  // console.log("done")
  const mod: IrModule = {
    irVersion: 4,
    sourceFile: "l.ts",
    entry: "__main",
    functions: [
      {
        name: "sideEffect",
        params: [],
        returnType: BOOL,
        locals: [],
        body: [
          { kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [{ kind: "strLit", value: "evaluated", type: STRING, loc }], type: VOID, loc }, loc },
          { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
        ],
        loc,
      },
      {
        name: "__main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [
          {
            kind: "if",
            cond: { kind: "logical", op: "&&", left: { kind: "boolLit", value: false, type: BOOL, loc }, right: { kind: "call", callee: "sideEffect", args: [], type: BOOL, loc }, type: BOOL, loc },
            then: [{ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc }, loc }],
            else_: null,
            loc,
          },
          {
            kind: "if",
            cond: { kind: "logical", op: "||", left: { kind: "boolLit", value: true, type: BOOL, loc }, right: { kind: "call", callee: "sideEffect", args: [], type: BOOL, loc }, type: BOOL, loc },
            then: [{ kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [{ kind: "strLit", value: "done", type: STRING, loc }], type: VOID, loc }, loc }],
            else_: null,
            loc,
          },
        ],
        loc,
      },
    ],
  };
  expect(await emitCompileRun(mod)).toBe("done\n");
});

test("string params: callee owns and releases; returns transfer ownership", async () => {
  const loc = { file: "p.ts", start: 0, end: 0 };
  // function greet(who: string): string { return "hi " + who; }
  // console.log(greet("world"));
  const mod: IrModule = {
    irVersion: 4,
    sourceFile: "p.ts",
    entry: "__main",
    functions: [
      {
        name: "greet",
        params: [{ localId: "who.0", name: "who", type: STRING }],
        returnType: STRING,
        locals: [{ id: "who.0", name: "who", type: STRING, mutable: false }],
        body: [
          {
            kind: "return",
            value: {
              kind: "strConcat",
              left: { kind: "strLit", value: "hi ", type: STRING, loc },
              right: { kind: "varRef", localId: "who.0", type: STRING, loc },
              type: STRING, loc,
            },
            loc,
          },
        ],
        loc,
      },
      {
        name: "__main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "intrinsic",
              name: "console.log",
              args: [{ kind: "call", callee: "greet", args: [{ kind: "strLit", value: "world", type: STRING, loc }], type: STRING, loc }],
              type: VOID, loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
  expect(await emitCompileRun(mod)).toBe("hi world\n");
});
