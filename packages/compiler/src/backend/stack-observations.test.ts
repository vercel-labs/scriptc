import { expect, test } from "vitest";
import {
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { captureFreeFunctions, observesStacks } from "./stack-observations.js";

const loc = { file: "stack-observations.ts", start: 0, end: 0 };
const ERROR = { kind: "object", className: "%Error" } as const;
const err: IrExpr = { loc, kind: "varRef", localId: "e", type: ERROR };
const stackRead: IrStmt = {
  loc,
  kind: "exprStmt",
  expr: { loc, kind: "libCall", fn: "error.stack", args: [err], type: STRING },
};
const call = (callee: string): IrStmt => ({
  loc,
  kind: "exprStmt",
  expr: { loc, kind: "call", callee, args: [], type: VOID },
});
const throwStmt: IrStmt = { loc, kind: "throw", value: err };
const ret: IrStmt = { loc, kind: "return", value: null };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  loc,
  name,
  params: [],
  locals: [],
  returnType: VOID,
  body,
});
const mod = (functions: IrFunction[], extra: Partial<IrModule> = {}): IrModule => ({
  irVersion: 17,
  sourceFile: "stack-observations.ts",
  entry: "%main",
  functions,
  classes: [],
  records: [],
  unions: [],
  globals: [],
  ...extra,
});

test("a reachable stack read is observed", () => {
  expect(observesStacks(mod([fn("%main", [call("parse")]), fn("parse", [stackRead])]))).toBe(true);
});

test("a stack read on a checked-dynamic value is observed", () => {
  const value: IrExpr = { loc, kind: "varRef", localId: "d", type: DYN };
  const read = (key: string): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: {
      loc,
      kind: "dynKeyGet",
      value,
      key: { loc, kind: "strLit", value: key, type: STRING },
      type: DYN,
    },
  });
  expect(observesStacks(mod([fn("%main", [read("stack")])]))).toBe(true);
  expect(observesStacks(mod([fn("%main", [read("message")])]))).toBe(false);
});

test("a computed key reads the stack when the program spells it", () => {
  const value: IrExpr = { loc, kind: "varRef", localId: "d", type: DYN };
  const key: IrExpr = { loc, kind: "varRef", localId: "k", type: STRING };
  const computed: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "dynKeyGet", value, key, type: DYN },
  };
  const spelled: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "strLit", value: "stack", type: STRING },
  };
  expect(observesStacks(mod([fn("%main", [computed, spelled])]))).toBe(true);
  expect(observesStacks(mod([fn("%main", [computed])]))).toBe(false);
});

test('a computed key that cannot be "stack" reads no stack', () => {
  const value: IrExpr = { loc, kind: "varRef", localId: "d", type: DYN };
  const spelled: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "strLit", value: "stack", type: STRING },
  };
  const read = (key: IrExpr): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "dynKeyGet", value, key, type: DYN },
  });
  const index: IrExpr = { loc, kind: "varRef", localId: "i", type: F64 };
  const indexText: IrExpr = { loc, kind: "toString", operand: index, type: STRING };
  // A number key, and a key converted from one.
  expect(observesStacks(mod([fn("%main", [read(index), spelled])]))).toBe(false);
  expect(observesStacks(mod([fn("%main", [read(indexText), spelled])]))).toBe(false);
  // An immutable local answers with its initializer (the shape of the
  // dispatch helpers' formatted index keys).
  const key: IrExpr = { loc, kind: "varRef", localId: "key", type: STRING };
  const local = (init: IrExpr, mutable = false): IrFunction => ({
    ...fn("%main", [{ loc, kind: "varDecl", localId: "key", init }, read(key), spelled]),
    locals: [{ id: "key", name: "key", type: STRING, mutable }],
  });
  expect(observesStacks(mod([local(indexText)]))).toBe(false);
  expect(observesStacks(mod([local(indexText, true)]))).toBe(true);
  // A parameter of a function called by name answers with its arguments.
  const helper: IrFunction = {
    ...fn("readKey", [read(key)]),
    params: [{ localId: "key", name: "key", type: STRING }],
    locals: [{ id: "key", name: "key", type: STRING, mutable: false }],
  };
  const callWith = (arg: IrExpr): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "call", callee: "readKey", args: [arg], type: DYN },
  });
  const numbers = mod([fn("%main", [callWith(indexText), spelled]), helper]);
  expect(observesStacks(numbers)).toBe(false);
  const stack = mod([
    fn("%main", [
      callWith(indexText),
      callWith({ loc, kind: "strLit", value: "stack", type: STRING }),
    ]),
    helper,
  ]);
  expect(observesStacks(stack)).toBe(true);
});

test("a key forwarded through functions with several call sites is searched once", () => {
  // f0 calls f1 twice, f1 calls f2 twice, and so on, each passing its
  // parameter on: 2^40 call paths reach the read in f40.
  const depth = 40;
  const value: IrExpr = { loc, kind: "varRef", localId: "d", type: DYN };
  const key: IrExpr = { loc, kind: "varRef", localId: "key", type: STRING };
  const forward = (callee: string): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "call", callee, args: [key], type: VOID },
  });
  const chain = (root: IrExpr): IrModule => {
    const functions: IrFunction[] = [];
    for (let i = 0; i <= depth; i++) {
      const body: IrStmt[] =
        i < depth
          ? [forward(`f${i + 1}`), forward(`f${i + 1}`)]
          : [{ loc, kind: "exprStmt", expr: { loc, kind: "dynKeyGet", value, key, type: DYN } }];
      functions.push({
        ...fn(`f${i}`, body),
        params: [{ localId: "key", name: "key", type: STRING }],
        locals: [{ id: "key", name: "key", type: STRING, mutable: false }],
      });
    }
    const spelled: IrStmt = {
      loc,
      kind: "exprStmt",
      expr: { loc, kind: "strLit", value: "stack", type: STRING },
    };
    const start: IrStmt = {
      loc,
      kind: "exprStmt",
      expr: { loc, kind: "call", callee: "f0", args: [root], type: VOID },
    };
    return mod([fn("%main", [start, spelled]), ...functions]);
  };
  expect(observesStacks(chain({ loc, kind: "strLit", value: "message", type: STRING }))).toBe(
    false,
  );
  expect(observesStacks(chain({ loc, kind: "strLit", value: "stack", type: STRING }))).toBe(true);
});

test("programs without stack reads are not", () => {
  expect(observesStacks(mod([fn("%main", [call("helper")]), fn("helper", [ret])]))).toBe(false);
});

test("reads after an unconditional throw or return never run", () => {
  expect(observesStacks(mod([fn("%main", [throwStmt, stackRead])]))).toBe(false);
  expect(observesStacks(mod([fn("%main", [ret, call("parse")]), fn("parse", [stackRead])]))).toBe(
    false,
  );
  // A terminator ends only its own list: the outer list continues.
  const cond: IrExpr = { loc, kind: "numLit", value: 1, type: F64 };
  expect(
    observesStacks(
      mod([fn("%main", [{ kind: "if", cond, then: [ret], else_: null, loc }, stackRead])]),
    ),
  ).toBe(true);
});

test("functions referenced only from dead code are unreached", () => {
  // The production React shape: a DEV-only body behind a throw stub calls
  // the stack parser, and a closure created after the stub reaches it too.
  const closure: IrStmt = {
    loc,
    kind: "assign",
    localId: "replacer",
    value: {
      loc,
      kind: "closure",
      fnName: "replacer",
      captures: [],
      type: { kind: "func", params: [], ret: VOID },
    },
  };
  const program = mod([
    fn("%main", [call("outline")]),
    fn("outline", [throwStmt, closure, call("parse")]),
    fn("replacer", [call("parse")]),
    fn("parse", [stackRead]),
  ]);
  expect(observesStacks(program)).toBe(false);
  // The same closure created before the stub keeps the read reachable.
  const live = mod([
    fn("%main", [call("outline")]),
    fn("outline", [closure, throwStmt]),
    fn("replacer", [call("parse")]),
    fn("parse", [stackRead]),
  ]);
  expect(observesStacks(live)).toBe(true);
});

test("class methods are roots", () => {
  const program = mod([fn("%main", [ret]), fn("%Parser.read", [stackRead])], {
    classes: [
      { name: "Parser", fields: [], methods: ["read"] } as unknown as NonNullable<
        IrModule["classes"]
      >[number],
    ],
  });
  expect(observesStacks(program)).toBe(true);
});

test("leaf functions that cannot create an Error need no frame", () => {
  const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
  const add: IrStmt = {
    loc,
    kind: "return",
    value: { loc, kind: "bin", op: "+", left: num(1), right: num(2), type: F64 },
  };
  const construct: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "libCall", fn: "error.new", args: [], type: ERROR },
  };
  const program = mod([
    fn("%main", [call("leaf"), call("caller"), call("creates"), call("viaCreates")]),
    fn("leaf", [add]),
    fn("caller", [call("leaf"), add]),
    fn("creates", [construct]),
    fn("viaCreates", [call("creates")]),
    fn("recursive", [call("recursive")]),
  ]);
  const free = captureFreeFunctions(program, new Set(["recursive"]), null);
  expect([...free].sort()).toEqual(["caller", "leaf"]);
  // A worker program keeps every frame.
  expect(captureFreeFunctions({ ...program, workers: true }, null, null).size).toBe(0);
});
