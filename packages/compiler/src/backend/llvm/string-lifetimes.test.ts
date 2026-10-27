import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  arrayOf,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrStrIntrinsicMethod,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { emitLlvmModule } from "./emitter.js";
import { borrowsStringInputs } from "./string-lifetimes.js";

/** A pending-exception check: the inline active-cell test or a runtime call. */
// Synchronous bodies test the kind of the entry-loaded exception cell.
const PENDING_CHECK = /@scr_exc_(?:active|pending)\b| = load i32, ptr %exc\.cell\b/;

const loc = { file: "strings.ts", start: 0, end: 1 };
const ref = (id: string, type: IrType = STRING): IrExpr => ({
  kind: "varRef",
  localId: id,
  type,
  loc,
});
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
const equal = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "strEq",
  left,
  right,
  negated: false,
  type: BOOL,
  loc,
});
const concat = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "strConcat",
  left,
  right,
  type: STRING,
  loc,
});
const intrinsic = (
  receiver: IrExpr,
  method: IrStrIntrinsicMethod,
  args: IrExpr[],
  type: IrType,
): IrExpr => ({ kind: "strIntrinsic", receiver, method, args, type, loc });
const call = (callee: string, args: IrExpr[], type: IrType): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});

function fn(name: string, names: string[], value: IrExpr): IrFunction {
  return {
    name,
    loc,
    params: names.map((id) => ({ localId: id, name: id, type: STRING })),
    locals: names.map((id) => ({ id, name: id, type: STRING, mutable: true })),
    returnType: value.type,
    body: [ret(value)],
  };
}
function mod(...functions: IrFunction[]): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", loc, params: [], locals: [], returnType: VOID, body: [] },
      ...functions,
    ],
  };
}
function body(module: IrModule, name: string, bits: 32 | 64 = 64): string {
  expect(validateModule(module)).toEqual([]);
  const match = new RegExp(`^define internal [^\\n]*@${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    emitLlvmModule(module, { pointerBits: bits }),
  );
  expect(match, name).not.toBeNull();
  return match![0];
}
function facts(...functions: IrFunction[]) {
  return analyzeCallLifetimes(new Map(functions.map((f) => [f.name, f])));
}

test("string comparisons borrow parameters while owned entry adapters release them", () => {
  const compare = fn("compare", ["left", "right"], equal(ref("left"), ref("right")));
  expect(facts(compare).parameters.get("compare")).toEqual(new Set([0, 1]));
  for (const bits of [32, 64] as const) {
    const borrowed = body(mod(compare), "sc_bf_compare", bits);
    expect(borrowed).toContain("@sc_str_eq");
    expect(borrowed).not.toContain("@scr_str_retain");
    expect(borrowed).not.toContain("@scr_str_release");
    const owned = body(mod(compare), "sc_f_compare", bits);
    expect(owned).toContain("@sc_bf_compare");
    expect(owned.match(/call void @scr_str_release/g)).toHaveLength(2);
  }
});

test("returning a borrowed input acquires a result owner", () => {
  const identity = fn("identity", ["text"], ref("text"));
  expect(facts(identity).parameters.size).toBe(0);
  // The borrowing body returns its input without a reference; direct
  // callers own it themselves and the owned adapter retains the result
  // before releasing the parameter.
  const ir = body(mod(identity), "sc_bf_identity");
  expect(ir).not.toContain("@scr_str_retain_v");
  expect(ir).not.toContain("@scr_str_release");
  const adapter = body(mod(identity), "sc_f_identity");
  expect(adapter.indexOf("@scr_str_retain_v")).toBeGreaterThan(0);
  expect(adapter.indexOf("@scr_str_release")).toBeGreaterThan(adapter.indexOf("@scr_str_retain_v"));
});

test("literal arguments remain immortal while the called body borrows them", () => {
  const inspect = fn("inspect", ["value"], intrinsic(ref("value"), "length", [], F64));
  const caller = fn("caller", [], call("inspect", [str("literal")], F64));
  const ir = body(mod(caller, inspect), "sc_f_caller");
  expect(ir).toContain("@sc_bf_inspect");
  expect(ir).not.toContain("@scr_str_retain_v");
  expect(ir).not.toContain("@scr_str_release");
});

test("reference-producing string operations retain their result owner", () => {
  for (const value of [
    intrinsic(ref("text"), "trim", [], STRING),
    intrinsic(ref("text"), "toWellFormed", [], STRING),
  ]) {
    const f = fn("transform", ["text"], value);
    expect(facts(f).parameters.get("transform")).toEqual(new Set([0]));
    const ir = body(mod(f), "sc_bf_transform");
    expect(ir).not.toContain("@scr_str_retain_v");
    expect(ir).toMatch(/ret ptr %/);
    expect(ir).not.toContain("@scr_str_release");
  }
});

test("concatenation protects a borrowed left binding from unique-reference append", () => {
  const f = fn("append", ["left", "right"], concat(ref("left"), ref("right")));
  const ir = body(mod(f), "sc_bf_append");
  const operation = ir.indexOf("@scr_str_concat");
  expect(ir.slice(0, operation).match(/@scr_str_retain_v/g)).toHaveLength(1);
  expect(ir.slice(operation)).toContain("@scr_str_release");
});

test("string operands preserve their left-to-right snapshot when a later assignment replaces the binding", () => {
  const assigned: IrExpr = {
    kind: "assignExpr",
    localId: "text",
    value: str("replacement"),
    type: STRING,
    loc,
  };
  const f = fn("replace", ["text"], equal(ref("text"), assigned));
  const ir = body(mod(f), "sc_f_replace");
  expect(ir.indexOf("@scr_str_retain_v")).toBeLessThan(ir.indexOf("@scr_str_release"));
  expect(ir).toContain("@sc_str_eq");
  expect(facts(f).parameters.has("replace")).toBe(false);
});

test("a callee's global write cannot replace the caller's mutable string locals", () => {
  const source = fn("source", [], str("next"));
  source.body.unshift({ kind: "assign", localId: "%g.changed", value: str("effect"), loc });
  const compare = fn("compare", ["text"], equal(ref("text"), call("source", [], STRING)));
  // A write anywhere in this function rules out parameter borrowing, but
  // the rebound local itself owns its value across the later operand.
  compare.body.unshift({ kind: "assign", localId: "text", value: str("first"), loc });
  const module = mod(source, compare);
  module.globals = [{ id: "%g.changed", name: "changed", type: STRING, mutable: true }];
  const ir = body(module, "sc_f_compare");
  const sourceCall = ir.indexOf("@sc_f_source");
  expect(sourceCall).toBeGreaterThan(0);
  expect(ir.slice(0, sourceCall)).not.toContain("@scr_str_retain_v");
  // Reading the global the later operand replaces still takes a snapshot.
  compare.body = [ret(equal(ref("%g.changed"), call("source", [], STRING)))];
  const global = body(module, "sc_bf_compare");
  expect(global.slice(0, global.indexOf("@sc_f_source"))).toContain("@scr_str_retain_v");
});

test("immutable lexical owners survive arbitrary later operands", () => {
  const source = fn("source", [], str("other"));
  const f = fn("compare", [], equal(ref("text"), call("source", [], STRING)));
  f.locals.push({ id: "text", name: "text", type: STRING, mutable: false });
  f.body.unshift({ kind: "varDecl", localId: "text", init: str("first"), loc });
  const ir = body(mod(source, f), "sc_f_compare");
  const sourceCall = ir.indexOf("@sc_f_source");
  // The literal is immortal, so its lexical alias and comparison borrow it.
  expect(ir.slice(0, sourceCall)).not.toContain("@scr_str_retain_v");
  expect(ir).toContain("@scr_str_release");
});

test("reference fields borrow across preserving calls but snapshot across writes", () => {
  const record: IrType = { kind: "record", shapeId: "text" };
  const projection: IrExpr = {
    kind: "recordGet",
    obj: ref("holder", record),
    shapeId: "text",
    field: "value",
    type: STRING,
    loc,
  };
  const source = fn("source", [], str("other"));
  const f = fn("compare", [], equal(projection, call("source", [], STRING)));
  f.params = [{ localId: "holder", name: "holder", type: record }];
  f.locals = [{ id: "holder", name: "holder", type: record, mutable: true }];
  const module = mod(source, f);
  module.records = [{ id: "text", fields: [{ name: "value", type: STRING }] }];
  const ir = body(module, "sc_bf_compare");
  expect(ir.slice(0, ir.indexOf("@sc_f_source"))).not.toContain("@scr_str_retain_v");
  source.locals.push({ id: "changed", name: "changed", type: STRING, mutable: true });
  source.body.unshift({ kind: "assign", localId: "changed", value: str("effect"), loc });
  expect(body(module, "sc_bf_compare")).not.toContain("@scr_str_retain_v");
  // A global write replaces no record field: the projection still borrows.
  source.body.unshift({ kind: "assign", localId: "%g.changed", value: str("effect"), loc });
  module.globals = [
    { id: "%g.changed", name: "changed", type: STRING, mutable: true },
    { id: "%g.record", name: "record", type: record, mutable: true },
  ];
  expect(body(module, "sc_bf_compare")).not.toContain("@scr_str_retain_v");
  // Writing the projected field of any record does replace it.
  source.body.unshift({
    kind: "recordSet",
    obj: ref("%g.record", record),
    shapeId: "text",
    field: "value",
    value: str("effect"),
    loc,
  });
  expect(body(module, "sc_bf_compare")).toContain("@scr_str_retain_v");
  f.body = [ret(equal(str("constant"), projection))];
  expect(body(module, "sc_bf_compare")).not.toContain("@scr_str_retain_v");
});

test("throwing string operations leave owned adapters responsible for parameters", () => {
  const f = fn(
    "normalize",
    ["text", "form"],
    intrinsic(ref("text"), "normalize", [ref("form")], STRING),
  );
  const module = mod(f);
  const borrowed = body(module, "sc_bf_normalize");
  expect(borrowed).toContain("@scr_str_normalize");
  expect(borrowed).toMatch(PENDING_CHECK);
  expect(borrowed).not.toContain("@scr_str_retain_v");
  const owned = body(module, "sc_f_normalize");
  expect(owned.match(/@scr_str_release/g)).toHaveLength(2);
});

test("a temporary receiver stays owned across a throwing argument", () => {
  const source = fn("source", [], str("temporary"));
  const failure = fn("failure", [], num(1));
  failure.body = [{ kind: "throw", value: str("failure"), loc }];
  const f = fn(
    "inspect",
    [],
    intrinsic(call("source", [], STRING), "charAt", [call("failure", [], F64)], STRING),
  );
  const ir = body(mod(source, failure, f), "sc_f_inspect");
  const argument = ir.indexOf("@sc_f_failure");
  expect(argument).toBeGreaterThan(ir.indexOf("@sc_f_source"));
  expect(ir.slice(argument)).toMatch(PENDING_CHECK);
  expect(ir.slice(argument)).toContain("@scr_str_release");
});

test("indirect calls keep the ordinary ABI even for a borrowing body", () => {
  const inspect = fn("inspect", ["text"], intrinsic(ref("text"), "length", [], F64));
  const value: IrExpr = {
    kind: "closure",
    fnName: "inspect",
    captures: [],
    type: funcOf([STRING], F64),
    loc,
  };
  const caller = fn("caller", [], {
    kind: "callValue",
    callee: value,
    args: [str("text")],
    type: F64,
    loc,
  });
  const llvm = emitLlvmModule(mod(inspect, caller));
  expect(llvm).toContain("@sc_f_inspect");
  expect(body(mod(inspect, caller), "sc_f_inspect")).toContain("@scr_str_release");
  expect(body(mod(inspect, caller), "sc_f_caller")).not.toContain("@scr_str_retain_v");
});

test("string method admission is explicit and unknown methods stay conservative", () => {
  expect(borrowsStringInputs("futureMethod" as IrStrIntrinsicMethod)).toBe(false);
});

const methodCases: {
  method: IrStrIntrinsicMethod;
  args: IrExpr[];
  result: IrType;
  target: string;
  /** Sites enter through the inlined sc_str_* wrapper (string-reads.ts). */
  inline?: boolean;
}[] = [
  { method: "length", args: [], result: F64, target: "utf16_len", inline: true },
  // An exact integer index skips the double conversion; any other index
  // enters through the double ABI.
  { method: "charCodeAt", args: [num(1)], result: F64, target: "char_code_at_int", inline: true },
  { method: "charCodeAt", args: [num(1.5)], result: F64, target: "char_code_at", inline: true },
  { method: "charAt", args: [num(1)], result: STRING, target: "char_at_int", inline: true },
  { method: "charAt", args: [num(1.5)], result: STRING, target: "char_at", inline: true },
  { method: "indexOf", args: [ref("argument"), num(1)], result: F64, target: "index_of" },
  { method: "includes", args: [ref("argument")], result: BOOL, target: "includes" },
  {
    method: "startsWith",
    args: [ref("argument"), num(1)],
    result: BOOL,
    target: "starts_with_from",
  },
  { method: "endsWith", args: [ref("argument"), num(4)], result: BOOL, target: "ends_with_from" },
  { method: "slice", args: [num(1), num(3)], result: STRING, target: "slice" },
  { method: "substring", args: [num(1), num(3)], result: STRING, target: "substring" },
  { method: "repeat", args: [num(2)], result: STRING, target: "repeat" },
  { method: "trim", args: [], result: STRING, target: "trim" },
  { method: "trimStart", args: [], result: STRING, target: "trim_start" },
  { method: "trimEnd", args: [], result: STRING, target: "trim_end" },
  {
    method: "split",
    args: [ref("argument"), num(2)],
    result: { kind: "array", elem: STRING },
    target: "split_limit",
  },
  { method: "padStart", args: [num(5), ref("argument")], result: STRING, target: "pad_start" },
  { method: "padEnd", args: [num(5), ref("argument")], result: STRING, target: "pad_end" },
  { method: "toLowerCase", args: [], result: STRING, target: "to_lower" },
  { method: "toUpperCase", args: [], result: STRING, target: "to_upper" },
  { method: "normalize", args: [ref("argument")], result: STRING, target: "normalize" },
  { method: "isWellFormed", args: [], result: BOOL, target: "is_well_formed" },
  { method: "toWellFormed", args: [], result: STRING, target: "to_well_formed" },
  { method: "cpAtByte", args: [num(1)], result: STRING, target: "cp_at_byte", inline: true },
];

test.each(methodCases)(
  "$method ($target) passes borrowed string inputs through its runtime ABI",
  ({ method, args, result, target, inline }) => {
    const f = fn(
      "method",
      ["receiver", "argument"],
      intrinsic(ref("receiver"), method, args, result),
    );
    for (const bits of [32, 64] as const) {
      const ir = body(mod(f), "sc_bf_method", bits);
      expect(ir).toContain(`@${inline ? "sc" : "scr"}_str_${target}(`);
      expect(ir).not.toContain("@scr_str_retain_v");
      // Throwing methods release their owned result on the unwind path.
      if (method !== "normalize" && method !== "repeat")
        expect(ir).not.toContain("@scr_str_release");
      expect(ir).toContain(
        result.kind === "f64" ? "ret double" : result.kind === "bool" ? "ret i1" : "ret ptr",
      );
    }
  },
);

test("string search borrows rebound locals but snapshots a global a later argument writes", () => {
  const position = fn("position", [], num(0));
  position.body.unshift({ kind: "assign", localId: "%g.changed", value: str("effect"), loc });
  const search = fn(
    "search",
    ["text", "needle"],
    intrinsic(ref("text"), "indexOf", [ref("needle"), call("position", [], F64)], F64),
  );
  search.body.unshift(
    { kind: "assign", localId: "text", value: str("abc"), loc },
    { kind: "assign", localId: "needle", value: str("b"), loc },
  );
  const module = mod(position, search);
  module.globals = [{ id: "%g.changed", name: "changed", type: STRING, mutable: true }];
  const ir = body(module, "sc_f_search");
  const start = ir.indexOf("@sc_f_position");
  const searchCall = ir.indexOf("@scr_str_index_of");
  expect(start).toBeGreaterThan(0);
  expect(searchCall).toBeGreaterThan(start);
  // The rebound locals own their values across the call: no snapshots.
  expect(ir.slice(0, start)).not.toContain("@scr_str_retain_v");
  // A receiver read from the global the numeric argument replaces does.
  search.body = [
    ret(intrinsic(ref("%g.changed"), "indexOf", [ref("needle"), call("position", [], F64)], F64)),
  ];
  const global = body(module, "sc_bf_search");
  const call2 = global.indexOf("@sc_f_position");
  expect(global.slice(0, call2).match(/@scr_str_retain_v/g)).toHaveLength(1);
  expect(global.slice(global.indexOf("@scr_str_index_of"))).toContain("@scr_str_release");
});

test("global string ownership cannot be inferred from an immutable-looking reference", () => {
  const replacement = fn("replacement", [], str("later"));
  replacement.body.unshift({ kind: "assign", localId: "%g.global", value: str("replaced"), loc });
  const inspect = fn("inspect", [], equal(ref("%g.global"), call("replacement", [], STRING)));
  const module = mod(replacement, inspect);
  module.globals = [{ id: "%g.global", name: "global", type: STRING, mutable: true }];
  const ir = body(module, "sc_f_inspect");
  expect(ir.slice(0, ir.indexOf("@sc_f_replacement"))).toContain("@scr_str_retain_v");
  inspect.returnType = F64;
  inspect.body = [ret(intrinsic(ref("%g.global"), "length", [], F64))];
  expect(body(module, "sc_f_inspect")).not.toContain("@scr_str_retain_v");
});

test("boxed string lengths borrow initialized payloads and keep checked TDZ reads", () => {
  const inspect = fn("inspect", ["value"], intrinsic(ref("value"), "length", [], F64));
  inspect.locals[0]!.boxed = true;
  // A never-rebound boxed parameter is borrowed; its box is created only
  // for an environment, so the body releases it only when one was built.
  expect(facts(inspect).borrowed.get("inspect")).toEqual(new Set([0]));
  const ir = body(mod(inspect), "sc_bf_inspect");
  expect(ir).toMatch(/br i1 %t\d+, label %lazy\.release\d+/);
  expect(ir).toContain("@scr_box_release");
  expect(ir).not.toContain("@scr_box_get_ref");
  expect(ir).toContain("@sc_str_utf16_len");
  inspect.locals[0]!.tdz = true;
  const checked = body(mod(inspect), "sc_f_inspect");
  expect(checked).toContain("@scr_box_get_ref");
  expect(checked).toContain("@scr_str_release");
});

test("borrowed literals keep UTF-16 string comparison without temporary owners", () => {
  const compare = fn("compare", [], {
    kind: "strCmp",
    op: "<",
    left: str("a"),
    right: str("b"),
    type: BOOL,
    loc,
  });
  const ir = body(mod(compare), "sc_f_compare");
  expect(ir).toContain("@sc_str_cmp_u16");
  expect(ir).not.toContain("@scr_str_retain_v");
  expect(ir).not.toContain("@scr_str_release");
});

test("string comparisons decide identity, lengths and leading bytes before the runtime", () => {
  const order = fn("order", [], {
    kind: "strCmp",
    op: "<",
    left: str("apple"),
    right: str("apricot"),
    type: BOOL,
    loc,
  });
  const same = fn("same", ["a", "b"], {
    kind: "strEq",
    left: { kind: "varRef", localId: "a", type: STRING, loc },
    right: { kind: "varRef", localId: "b", type: STRING, loc },
    negated: false,
    type: BOOL,
    loc,
  });
  for (const bits of [32, 64] as const) {
    const ir = emitLlvmModule(mod(order, same), { pointerBits: bits });
    const helper = (name: string) =>
      new RegExp(`^define internal [^\\n]*@${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(ir)![0];
    const eq = helper("sc_str_eq");
    expect(eq).toContain("icmp eq ptr %a, %b");
    expect(eq).toMatch(/icmp eq i(32|64) %alen, %blen/);
    expect(eq).toContain("call zeroext i1 @scr_str_eq(ptr %a, ptr %b)");
    const units = helper("sc_str_cmp_u16");
    expect(units).toContain("%dx = phi i64 [ %aw, %word ], [ %at, %tail ]");
    expect(units).toContain("%dlow = icmp eq i64 %whigh, 0");
    expect(units).toContain("@llvm.bswap.i64");
    expect(units).toContain("%dtz = call i64 @llvm.cttz.i64(i64 %dxor, i1 true)");
    expect(units).toContain("%bx = phi i8 [ %x, %first ], [ %dxb, %locate ]");
    expect(units).toContain("%blow = icmp ult i8 %bmin, -19");
    expect(units).toContain("%kbelow = icmp ult i8 %xk, %yk");
    expect(units).toContain("%below = icmp ult i8 %bx, %by");
    expect(units).toContain("%tailable = and i1 %samelen, %short");
    expect(units).toContain("%anyascii = icmp slt i32 %cws, 0");
    expect(units).toContain(
      "call i32 @scr_str_cmp(ptr %a, ptr %b) nounwind willreturn memory(argmem: read)",
    );
    expect(units).toContain(
      "call i32 @scr_str_cmp_u16_bytes(ptr %a, ptr %b) nounwind willreturn memory(argmem: read)",
    );
  }
});

test("a string field or array-slot self-append lets the container go before the concat", () => {
  const recordT = { kind: "record", shapeId: "buf" } as const;
  const arrT = arrayOf(STRING);
  const field: IrFunction = {
    name: "field",
    loc,
    params: [
      { localId: "r", name: "r", type: recordT },
      { localId: "s", name: "s", type: STRING },
    ],
    locals: [
      { id: "r", name: "r", type: recordT, mutable: false },
      { id: "s", name: "s", type: STRING, mutable: false },
    ],
    returnType: VOID,
    body: [
      {
        kind: "recordSet",
        obj: ref("r", recordT),
        shapeId: "buf",
        field: "text",
        value: concat(
          {
            kind: "recordGet",
            obj: ref("r", recordT),
            shapeId: "buf",
            field: "text",
            type: STRING,
            loc,
          },
          ref("s"),
        ),
        loc,
      },
    ],
  };
  const slot: IrFunction = {
    name: "slot",
    loc,
    params: [
      { localId: "a", name: "a", type: arrT },
      { localId: "i", name: "i", type: F64 },
      { localId: "s", name: "s", type: STRING },
    ],
    locals: [
      { id: "a", name: "a", type: arrT, mutable: false },
      { id: "i", name: "i", type: F64, mutable: false },
      { id: "s", name: "s", type: STRING, mutable: false },
    ],
    returnType: VOID,
    body: [
      {
        kind: "arraySet",
        arr: ref("a", arrT),
        index: ref("i", F64),
        value: concat(
          { kind: "arrayGet", arr: ref("a", arrT), index: ref("i", F64), type: STRING, loc },
          ref("s"),
        ),
        loc,
      },
    ],
  };
  const module: IrModule = {
    ...mod(field, slot),
    records: [{ id: "buf", fields: [{ name: "text", type: STRING }] }],
  };
  expect(validateModule(module)).toEqual([]);
  const ir = emitLlvmModule(module, { pointerBits: 64 });
  const define = (name: string): string =>
    new RegExp(`^define internal [^\\n]*@sc_b?f_${name}\\([^]*?^}`, "m").exec(ir)![0];
  const appendField = define("field");
  const concatAt = appendField.indexOf("@scr_str_concat(");
  expect(concatAt).toBeGreaterThan(0);
  expect(appendField.slice(0, concatAt)).toMatch(/store ptr null, ptr %/);
  expect(appendField.slice(0, concatAt)).toContain("@scr_str_release");
  const appendSlot = define("slot");
  const slotConcat = appendSlot.indexOf("@scr_str_concat(");
  expect(appendSlot.slice(0, slotConcat)).toContain("arr.unlink.swap");
  expect(appendSlot.slice(slotConcat)).toContain("arr.set");
});
