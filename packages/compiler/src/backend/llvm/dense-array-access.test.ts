import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  type IrExpr,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "dense-array-access.ts", start: 0, end: 0 };
const nums = arrayOf(F64);
const flags = arrayOf(BOOL);
const words = arrayOf(STRING);
const ref = (localId: string, type: IrExpr["type"]): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const index = ref("i", F64);

function module(name: string, returnType: IrExpr["type"], body: IrStmt[]): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name,
        params: [
          { name: "a", localId: "a", type: nums },
          { name: "b", localId: "b", type: flags },
          { name: "s", localId: "s", type: words },
          { name: "i", localId: "i", type: F64 },
        ],
        returnType,
        locals: [
          { id: "a", name: "a", type: nums, mutable: false },
          { id: "b", name: "b", type: flags, mutable: false },
          { id: "s", name: "s", type: words, mutable: false },
          { id: "i", name: "i", type: F64, mutable: false },
        ],
        body,
        loc,
      },
    ],
  };
}

function body(llvm: string, name: string): string {
  return new RegExp(`^define internal [^\\n]*@sc_bf_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  )![0];
}

test.each([32, 64] as const)(
  "property reads own one Get and use only the installed element codec (%i-bit)",
  (bits) => {
    const optional = { kind: "union" as const, unionId: "optional-number" };
    const read: IrExpr = {
      kind: "arrayPropertyRead",
      arr: ref("a", nums),
      index,
      consume: "value",
      type: optional,
      loc,
    };
    const input = module("property", optional, [{ kind: "return", value: read, loc }]);
    input.unions = [{ id: optional.unionId, arms: [F64, UNDEFINED_T] }];
    const llvm = emitLlvmModule(input, { pointerBits: bits });
    const fn = body(llvm, "property");
    expect(fn.match(/call ptr @scr_arr_property_get\(/g)).toHaveLength(1);
    expect(fn).toContain("@scr_arr_named_promoted(");
    expect(fn).toContain("@scr_arr_property_unbox(");
    expect(fn).toContain("property.undefined");
    expect(fn).toContain("property.converted");
    expect(fn).toMatch(/load double, ptr /);
    expect(fn).not.toContain("@scr_arr_borrow_slot_ref");
    expect(llvm).not.toContain("define internal ptr @sc_slot_box_");
    expect(llvm).not.toContain("define internal zeroext i1 @sc_slot_unbox_");
  },
);

test.each([32, 64] as const)(
  "property consumers preserve Get coercion and getter-free presence (%i-bit)",
  (bits) => {
    for (const consume of ["number", "numberConstructor", "boolean", "string"] as const) {
      const type = consume === "boolean" ? BOOL : consume === "string" ? STRING : F64;
      const arr = consume === "string" ? ref("s", words) : ref("a", nums);
      const read: IrExpr = { kind: "arrayPropertyRead", arr, index, consume, type, loc };
      const fn = body(
        emitLlvmModule(module("coerce", type, [{ kind: "return", value: read, loc }]), {
          pointerBits: bits,
        }),
        "coerce",
      );
      expect(fn.match(/call ptr @scr_arr_property_get\(/g)).toHaveLength(1);
      const callee = {
        number: "scr_dyn_number_coerce",
        numberConstructor: "scr_dyn_number_constructor",
        boolean: "scr_dyn_truthy",
        string: "scr_dyn_string_coerce_js",
      }[consume];
      expect(fn).toContain(`@${callee}(`);
      expect(fn).not.toContain("@scr_arr_property_unbox(");
    }
    const has: IrExpr = { kind: "arrayHasProperty", arr: ref("a", nums), index, type: BOOL, loc };
    const fn = body(
      emitLlvmModule(module("present", BOOL, [{ kind: "return", value: has, loc }]), {
        pointerBits: bits,
      }),
      "present",
    );
    expect(fn).toContain("@scr_arr_has_property(");
    expect(fn).not.toContain("@scr_arr_property_get(");
  },
);

test.each([32, 64] as const)("strict scalar reads check dense storage inline (%i-bit)", (bits) => {
  const read: IrExpr = { kind: "arrayGet", arr: ref("a", nums), index, type: F64, loc };
  const llvm = emitLlvmModule(module("get", F64, [{ kind: "return", value: read, loc }]), {
    pointerBits: bits,
  });
  const fn = body(llvm, "get");
  // A double index must round-trip exactly; NaN/out-of-range conversions are frozen.
  expect(fn).toContain("fptosi double");
  expect(fn).toContain("freeze i64");
  expect(fn).toMatch(/icmp ult i64 .*/);
  expect(fn).toMatch(/load i8, ptr /);
  expect(fn).toMatch(/icmp eq i8 .*, 1$/m);
  expect(fn).toMatch(/load double, ptr /);
  expect(fn).toMatch(
    /call double @scr_arr_get_slot_f64\(.*\) cold memory\(read, inaccessiblemem: readwrite\)/,
  );
  if (bits === 32) expect(fn).toContain("trunc i64");
});

test.each([32, 64] as const)("boolean reads load one byte per element (%i-bit)", (bits) => {
  const read: IrExpr = { kind: "arrayGet", arr: ref("b", flags), index, type: BOOL, loc };
  const llvm = emitLlvmModule(module("flag", BOOL, [{ kind: "return", value: read, loc }]), {
    pointerBits: bits,
  });
  const fn = body(llvm, "flag");
  const size = bits === 32 ? "i32" : "i64";
  expect(fn).toMatch(
    new RegExp(
      `getelementptr inbounds i8, ptr %t\\d+, ${size} %t\\d+\\n  %t(\\d+) = load i8, ptr .*\\n  %t\\d+ = icmp ne i8 %t\\1, 0`,
    ),
  );
  expect(fn).not.toMatch(/getelementptr inbounds i64/);
  expect(fn).toMatch(/call i1 @scr_arr_get_slot_bool\(.*\) cold/);
});

test("reference reads retain inline and keep a cold +1 runtime fallback", () => {
  const read: IrExpr = { kind: "arrayGet", arr: ref("s", words), index, type: STRING, loc };
  // An element removal in the body keeps the read from being lent as a
  // borrowed return: the result must own its reference.
  const truncate: IrStmt = {
    kind: "arraySetLength",
    arr: ref("s", words),
    length: { kind: "numLit", value: 1, type: F64, loc },
    loc,
  };
  const llvm = emitLlvmModule(
    module("word", STRING, [truncate, { kind: "return", value: read, loc }]),
  );
  const fn = body(llvm, "word");
  expect(fn).toMatch(/icmp ne ptr .*, null/);
  expect(fn).toContain("@scr_str_retain_v(");
  // The retaining getter writes reference counts, so it gets no read-only effect.
  expect(fn).toMatch(/call ptr @scr_arr_get_slot_ref\(.*\) cold$/m);
});

test.each([32, 64] as const)("element writes guard before inline storage (%i-bit)", (bits) => {
  const set = (arr: IrExpr, value: IrExpr): IrStmt => ({
    kind: "arraySet",
    arr,
    index,
    value,
    loc,
  });
  const llvm = emitLlvmModule(
    module("store", VOID, [
      set(ref("a", nums), { kind: "numLit", value: 2.5, type: F64, loc }),
      set(ref("b", flags), { kind: "boolLit", value: true, type: BOOL, loc }),
      set(ref("s", words), { kind: "strLit", value: "x", type: STRING, loc }),
    ]),
    { pointerBits: bits },
  );
  const fn = body(llvm, "store");
  expect(fn).toMatch(/store double 0x4004000000000000, ptr /);
  // Boolean elements are one byte each.
  expect(fn).toMatch(
    /getelementptr inbounds i8, ptr .*\n  %t\d+ = zext i1 .* to i8\n  store i8 %t\d+, ptr /,
  );
  expect(fn).toMatch(/store i8 1, ptr /);
  expect(fn).toMatch(new RegExp(`icmp uge i${bits} .*`));
  const guards = [...fn.matchAll(/call zeroext i1 @scr_arr_check_set\([^\n]+/g)];
  expect(guards).toHaveLength(3);
  for (let i = 0; i < guards.length; i++) {
    const guarded = fn.slice(guards[i]!.index! + guards[i]![0].length, guards[i + 1]?.index);
    const pending = guarded.search(/@scr_exc_(?:active|pending)\b| = load i32, ptr %exc\.cell\b/);
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(pending).toBeLessThan(guarded.indexOf("arr.set."));
  }
  expect(fn).toContain("call void @scr_str_release(");
  for (const acc of ["f64", "bool", "ref"]) {
    expect(fn).toMatch(new RegExp(`call void @scr_arr_set_${acc}\\(.*\\) cold$`, "m"));
  }
});

test.each([32, 64] as const)("fresh construction keeps dense append storage (%i-bit)", (bits) => {
  const cases: [IrExpr["type"], IrExpr, string][] = [
    [nums, { kind: "numLit", value: 2.5, type: F64, loc }, "f64"],
    [flags, { kind: "boolLit", value: true, type: BOOL, loc }, "bool"],
    [words, { kind: "strLit", value: "x", type: STRING, loc }, "ref"],
  ];
  for (const [type, value, access] of cases) {
    const fresh: IrExpr = { kind: "arrayLit", elems: [value], type, loc };
    const fn = body(
      emitLlvmModule(module("fresh", type, [{ kind: "return", value: fresh, loc }]), {
        pointerBits: bits,
      }),
      "fresh",
    );
    expect(fn).toContain("arr.push.dense");
    expect(fn).toMatch(new RegExp(`call double @scr_arr_push_${access}\\(.*\\) cold$`, "m"));
    expect(fn).toContain("store i8 1, ptr ");
    expect(fn).not.toContain("@scr_arr_check_set");
    expect(fn).not.toContain("@scr_str_release(");
  }
});

test.each([32, 64] as const)(
  "indices below the hole-free prefix bound skip the state bytes (%i-bit)",
  (bits) => {
    const read: IrExpr = { kind: "arrayGet", arr: ref("a", nums), index, type: F64, loc };
    const llvm = emitLlvmModule(
      module("bound", VOID, [
        {
          kind: "arraySet",
          arr: ref("a", nums),
          index,
          value: { kind: "bin", op: "+", left: read, right: read, type: F64, loc },
          loc,
        },
        {
          kind: "arraySet",
          arr: ref("s", words),
          index,
          value: { kind: "strLit", value: "x", type: STRING, loc },
          loc,
        },
      ]),
      { pointerBits: bits },
    );
    const fn = body(llvm, "bound");
    const size = bits === 32 ? "i32" : "i64";
    // The bound is %ScrArr field 6, an i32 compared against the index.
    const bound = fn.match(/getelementptr inbounds %ScrArr, ptr .*, i32 0, i32 6$/gm) ?? [];
    expect(bound.length).toBeGreaterThanOrEqual(4);
    expect(fn).toMatch(/load i32, ptr /);
    // The prefix blocks load or store the slot without a state access.
    const blocks = (label: string): string[] =>
      [...fn.matchAll(new RegExp(`^${label}\\d+:\\n((?:  .*\\n)*)`, "gm"))].map((m) => m[1]!);
    const reads = blocks("arr\\.get\\.value");
    expect(reads).toHaveLength(2);
    for (const block of reads) {
      expect(block).toMatch(/load double, ptr /);
      expect(block).not.toMatch(/i8/);
    }
    const writes = blocks("arr\\.set\\.filled");
    expect(writes).toHaveLength(2);
    for (const block of writes) expect(block).not.toMatch(/i8/);
    expect(writes[0]).toMatch(/store double .*, ptr /);
    // The replaced string below the bound is released after the store.
    expect(writes[1]).toMatch(/store ptr .*\n[^]*call void @scr_str_release\(/);
    // A state-checked store at the bound extends it to the index plus one,
    // not to the loaded bound plus one (no store-to-load chain in a loop).
    expect(fn).toMatch(new RegExp(`icmp eq ${size} .*`));
    const bumps = blocks("arr\\.set\\.bump");
    expect(bumps).toHaveLength(2);
    const loadedBounds = new Set(
      [...fn.matchAll(/^\s*(%[\w.]+) = load i32, ptr /gm)].map((m) => m[1]),
    );
    for (const block of bumps) {
      const next = block.match(/= add i32 (%[\w.]+), 1\n/);
      expect(next).not.toBeNull();
      expect(loadedBounds.has(next![1]!)).toBe(false);
      expect(block).toMatch(/store i32 .*, ptr /);
    }
  },
);

test("state and presence queries answer dense slots inline", () => {
  const state: IrExpr = { kind: "arrayState", arr: ref("b", flags), index, type: F64, loc };
  const has: IrExpr = { kind: "arrayHas", arr: ref("s", words), index, type: BOOL, loc };
  const llvm = emitLlvmModule(
    module("query", BOOL, [
      {
        kind: "return",
        value: {
          kind: "logical",
          op: "&&",
          left: {
            kind: "bin",
            op: "===",
            left: state,
            right: { kind: "numLit", value: 1, type: F64, loc },
            type: BOOL,
            loc,
          },
          right: has,
          type: BOOL,
          loc,
        },
        loc,
      },
    ]),
  );
  const fn = body(llvm, "query");
  expect(fn).toMatch(/uitofp i8 .* to double/);
  expect(fn).toMatch(/icmp ne i8 .*, 0/);
  expect(fn).toMatch(/call double @scr_arr_state\(.*\) cold memory\(read/);
  expect(fn).toMatch(/call i1 @scr_arr_has\(.*\) cold$/m);
});

test("statement-position splices insert values without result or item arrays", () => {
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const splice = (items: IrExpr[] | null): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "arrIntrinsic",
      method: items ? "spliceInsert" : "splice",
      receiver: ref("s", words),
      args: [
        index,
        num(0),
        ...(items ? [{ kind: "arrayLit" as const, elems: items, type: words, loc }] : []),
      ],
      type: words,
      loc,
    },
    loc,
  });
  const llvm = emitLlvmModule(
    module("insert", VOID, [
      splice([{ kind: "strLit", value: "x", type: STRING, loc }]),
      splice(null),
    ]),
  );
  const fn = body(llvm, "insert");
  expect(fn.match(/call void @scr_arr_splice_drop\(/g)).toHaveLength(2);
  expect(fn).toMatch(/call void @scr_arr_splice_drop\(.*, i64 1, ptr %t\d+\)/);
  expect(fn).toMatch(/call void @scr_arr_splice_drop\(.*, i64 0, ptr null\)/);
  expect(fn).not.toContain("@scr_arr_new");
  expect(fn).not.toContain("@scr_arr_splice_insert");
  expect(fn).not.toContain("@scr_arr_release");
});

test("length assignments always reach the runtime integrity boundary", () => {
  const llvm = emitLlvmModule(
    module("reset", VOID, [{ kind: "arraySetLength", arr: ref("s", words), length: index, loc }]),
  );
  const fn = body(llvm, "reset");
  expect(fn.match(/call void @scr_arr_set_len\(/g)).toHaveLength(1);
  expect(fn).not.toContain("arr.len.done");
  expect(fn.slice(fn.indexOf("call void @scr_arr_set_len("))).toMatch(
    /@scr_exc_(?:active|pending)\b| = load i32, ptr %exc\.cell\b/,
  );
});

test.each([
  { workers: false, targetTriple: "x86_64-unknown-linux-gnu" },
  { workers: true, targetTriple: "x86_64-unknown-linux-gnu" },
  { workers: true, targetTriple: "arm64-apple-macosx14.0.0" },
])(
  "undefined and delete unwind after runtime refusal ($targetTriple, workers=$workers)",
  ({ workers, targetTriple }) => {
    for (const kind of ["arraySetUndefined", "arrayDelete"] as const) {
      const mod = module("mutate", VOID, [{ kind, arr: ref("a", nums), index, loc }]);
      mod.workers = workers;
      const fn = body(emitLlvmModule(mod, { targetTriple }), "mutate");
      const callee = kind === "arrayDelete" ? "scr_arr_delete" : "scr_arr_set_undefined";
      const call = new RegExp(`call (?:zeroext i1|void) @${callee}\\([^\\n]+`).exec(fn);
      expect(call).not.toBeNull();
      const after = fn.slice(call!.index + call![0].length);
      if (!workers) expect(after).toContain(" = load i32, ptr %exc.cell");
      else if (targetTriple.includes("linux")) {
        expect(after).toContain("load atomic i32, ptr @scr_exc_flag unordered");
        expect(after).not.toContain("@scr_exc_pending");
      } else {
        expect(after).toContain("load atomic i32, ptr @scr_exc_alert monotonic");
        expect(after).toContain("call zeroext i1 @scr_exc_pending()");
      }
      const branch = /br i1 [^,]+, label %(exc\.u\d+), label %exc\.k\d+/.exec(after);
      expect(branch).not.toBeNull();
      const unwind = after.split(`${branch![1]}:\n`)[1]!.split(/^\w[\w.]*:/m)[0]!;
      expect(unwind).toContain("@scr_arr_release(");
      expect(unwind).toContain("ret void");
    }
  },
);

test("a discarded conditional splice drops the result of its literal arm", () => {
  const insert = (items: IrExpr): IrExpr => ({
    kind: "arrIntrinsic",
    method: "spliceInsert",
    receiver: ref("s", words),
    args: [index, { kind: "numLit", value: 0, type: F64, loc }, items],
    type: words,
    loc,
  });
  const word: IrExpr = { kind: "strLit", value: "x", type: STRING, loc };
  const llvm = emitLlvmModule(
    module("pick", VOID, [
      {
        kind: "exprStmt",
        expr: {
          kind: "seqExpr",
          stmts: [],
          result: {
            kind: "ternary",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            then: insert({
              kind: "seqExpr",
              stmts: [],
              result: { kind: "arrayLit", elems: [word], type: words, loc },
              type: words,
              loc,
            }),
            else_: insert({ kind: "arrayLit", elems: [word], type: words, loc }),
            type: words,
            loc,
          },
          type: words,
          loc,
        },
        loc,
      },
    ]),
  );
  const fn = body(llvm, "pick");
  expect(fn.match(/call void @scr_arr_splice_drop\(/g)).toHaveLength(1);
  expect(fn.match(/call ptr @scr_arr_splice_insert\(/g)).toHaveLength(1);
  expect(fn).toMatch(/drop\.t\d*:/);
});

test("an empty literal's capacity hint sizes its first dense storage", () => {
  const llvm = emitLlvmModule(
    module("fresh", words, [
      {
        kind: "return",
        value: { kind: "arrayLit", elems: [], capacity: 3, type: words, loc },
        loc,
      },
    ]),
  );
  expect(body(llvm, "fresh")).toMatch(/call ptr @scr_arr_new\(.*, i64 3\)/);
});
