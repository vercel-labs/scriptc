import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrModule } from "../../ir/ir.js";
import { buildClassGraph, classMembershipIntervals, emitClassMembershipHelper } from "./classes.js";
import { emitLlvmModule } from "./emitter.js";
import {
  mangleClassNew,
  mangleClassReleaseDirect,
  mangleClassRelease,
  mangleClassRetain,
  mangleClassTrace,
  mangleRecordRelease,
} from "../mangle.js";

const loc = { file: "class-membership.ts", start: 0, end: 1 };

test("leaf layouts keep direct teardown while recursive layouts share the depth budget", () => {
  const linked = { kind: "object" as const, className: "Linked" };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Scalar", fields: [{ name: "value", type: F64 }], methods: [], loc },
      {
        name: "Text",
        base: "Scalar",
        fields: [
          { name: "value", type: F64 },
          { name: "text", type: STRING },
        ],
        methods: [],
        loc,
      },
      { name: "Linked", fields: [{ name: "next", type: linked }], methods: [], loc },
    ],
    records: [
      { id: "leaf", fields: [{ name: "text", type: STRING }] },
      { id: "branch", fields: [{ name: "next", type: linked }] },
    ],
  };
  for (const pointerBits of [32, 64] as const) {
    const llvm = emitLlvmModule(mod, { pointerBits });
    for (const [name, bounded] of [
      [mangleClassReleaseDirect("Scalar"), false],
      [mangleClassReleaseDirect("Text"), false],
      // Standalone and record releases keep their teardown in the out-of-line
      // half; the public symbol is the inlinable fast path.
      [`${mangleRecordRelease("leaf")}_slow`, false],
      [`${mangleClassRelease("Linked")}_slow`, true],
      [`${mangleRecordRelease("branch")}_slow`, true],
    ] as const) {
      const body = new RegExp(`^define internal void @${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
        llvm,
      )?.[0];
      expect(body, name).toBeDefined();
      expect(body?.includes("call void @scr_rc_destroy"), name).toBe(bounded);
    }
  }
});

test("releases split into an inlinable fast path and an out-of-line remainder", () => {
  // An array of the class itself makes the hierarchy cycle-capable.
  const kids = { kind: "array" as const, elem: { kind: "object" as const, className: "Node" } };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Node", fields: [{ name: "kids", type: kids }], methods: [], loc },
      { name: "Leaf", base: "Node", fields: [{ name: "kids", type: kids }], methods: [], loc },
    ],
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const body = (name: string): string =>
    new RegExp(`^define internal void @${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
  // A hierarchy rooted in the program: a surviving release decrements and
  // takes the possible-root step without loading the vtable.
  const fast = body(mangleClassRelease("Node"));
  expect(fast).toContain("%shared = icmp ult i64 %rcm2, -3");
  expect(fast).toContain("load i32, ptr %bufp");
  expect(fast).toContain(`call void @${mangleClassRelease("Node")}_slow(ptr %o)`);
  expect(fast).not.toContain("%ScrVt");
  // Only the last reference dispatches, from a noinline remainder.
  const slow = body(`${mangleClassRelease("Node")}_slow`);
  expect(slow).toMatch(/noinline/);
  expect(slow).toContain("getelementptr inbounds %ScrVt, ptr %vt, i64 0, i32 2");
});

test("ProgramLifetime hierarchies are never freed and take no reference counts", () => {
  const kids = { kind: "array" as const, elem: { kind: "object" as const, className: "Node" } };
  const owners = { kind: "array" as const, elem: { kind: "object" as const, className: "Owner" } };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Node", fields: [{ name: "kids", type: kids }], methods: [], loc },
      { name: "Leaf", base: "Node", fields: [{ name: "kids", type: kids }], methods: [], loc },
      // A mortal class on its own cycle (array edges are mutable) that also
      // holds program-lifetime nodes.
      {
        name: "Owner",
        fields: [
          { name: "next", type: owners },
          { name: "nodes", type: kids },
        ],
        methods: [],
        loc,
      },
    ],
    contracts: { programLifetime: ["Node"] },
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const body = (name: string): string =>
    new RegExp(`^define internal [a-z]+ @${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
  for (const cls of ["Node", "Leaf"]) {
    // Retain and release are empty, so every inlined call site folds away.
    expect(body(mangleClassRetain(cls)), cls).toMatch(/entry:\n {2}ret ptr %o\n}/);
    expect(body(mangleClassRelease(cls)), cls).toMatch(/entry:\n {2}ret void\n}/);
    // new: no collector header (no descriptor, no scr_cyc_alloc) and the
    // program-lifetime count 2^63, not SIZE_MAX (which means published).
    const nw = body(mangleClassNew(cls));
    expect(nw, cls).toContain("store i64 -9223372036854775808, ptr %o");
    expect(nw, cls).not.toContain("store i64 -1, ptr %o");
    expect(nw, cls).not.toContain("scr_cyc_alloc");
    expect(llvm, cls).not.toContain(`@${mangleClassTrace(cls)}.cyctype`);
    // The RC audit (sanitize builds) learns that the program keeps
    // program-lifetime objects; other builds emit nothing for it.
    expect(nw, cls).toContain("call void @scr_obj_lifetime_note(ptr %o)");
  }
  const plain = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false });
  expect(plain).not.toContain("scr_obj_lifetime_note");
  // The mortal Owner keeps its header, counts and possible-root step.
  expect(body(mangleClassNew("Owner"))).toContain("store i64 1, ptr %o");
  expect(body(mangleClassNew("Owner"))).toContain("scr_cyc_alloc");
  expect(body(mangleClassRelease("Owner"))).toContain("load i32, ptr %bufp");
});

test("published ProgramLifetime instances use the published mark every other object uses", () => {
  const node = { kind: "object" as const, className: "Node" };
  const leaf = { kind: "object" as const, className: "Leaf" };
  const root = { localId: "root", name: "root", type: node };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [root],
        returnType: VOID,
        locals: [{ id: "root", name: "root", type: node, mutable: false }],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "intrinsic",
              name: "threads.publish",
              args: [{ kind: "varRef", localId: "root", type: node, loc }],
              type: node,
              loc,
            },
            loc,
          },
          {
            kind: "fieldSet",
            obj: { kind: "varRef", localId: "root", type: node, loc },
            className: "Node",
            field: "weight",
            value: { kind: "numLit", value: 1, type: F64, loc },
            loc,
          },
        ],
        loc,
      },
    ],
    classes: [
      {
        name: "Node",
        fields: [
          { name: "parent", type: node },
          { name: "weight", type: F64 },
        ],
        methods: [],
        loc,
      },
      {
        name: "Leaf",
        base: "Node",
        fields: [
          { name: "parent", type: node },
          { name: "weight", type: F64 },
          { name: "next", type: leaf },
        ],
        methods: [],
        loc,
      },
    ],
    contracts: { programLifetime: ["Node"] },
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  // The walker marks each instance like a mortal object (SIZE_MAX, logged so
  // a refusal restores the program-lifetime count); untraced, so it never
  // leaves a collector buffer.
  expect(llvm).toContain("call void @scr_publish(ptr");
  expect(llvm).toMatch(/@scr_pub_mark\(ptr %ctx, ptr %o, i1 false, i32 4\)/);
  // The frozen-object guard of the store tests the count against SIZE_MAX:
  // an unpublished instance (2^63) stays writable.
  const store =
    llvm.split(/^define /m).find((fn) => fn.includes("call void @scr_throw_published_field(")) ??
    "";
  expect(store).toMatch(/icmp eq i64 %\S+, -1/);
  expect(store).toContain("call void @scr_publish(ptr");
  // 32-bit targets use 2^31.
  const llvm32 = emitLlvmModule(mod, { pointerBits: 32 });
  const nw32 =
    new RegExp(`^define internal [a-z]+ @${mangleClassNew("Leaf")}(?:\\.i32)?\\([^]*?^}`, "m").exec(
      llvm32,
    )?.[0] ?? "";
  expect(nw32).toContain("store i32 -2147483648, ptr %o");
});

function graph() {
  const classes = [
    { name: "Root" },
    { name: "Pair", base: "Root" },
    { name: "Flipped", base: "Pair" },
    { name: "PairNumber", base: "Pair", genericOf: "Pair" },
    { name: "FlippedNumber", base: "PairNumber", genericOf: "Flipped" },
    { name: "Child", base: "FlippedNumber" },
    { name: "Other", base: "PairNumber" },
    { name: "PairString", base: "Pair", genericOf: "Pair" },
    { name: "FlippedString", base: "PairString", genericOf: "Flipped" },
  ];
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [],
    classes: classes.map((cls) => ({ ...cls, fields: [], methods: [], loc })),
  };
  return buildClassGraph(mod, new Map());
}

test("nominal family ranges include specialized descendants without admitting intervening classes", () => {
  const classes = graph();
  const contains = (target: string, member: string) =>
    classMembershipIntervals(classes, target).some(
      (range) => range.pre <= classes.get(member)!.pre && classes.get(member)!.pre <= range.post,
    );
  for (const member of ["Flipped", "FlippedNumber", "FlippedString", "Child"])
    expect(contains("Flipped", member), member).toBe(true);
  for (const member of ["Root", "Pair", "PairNumber", "PairString", "Other"])
    expect(contains("Flipped", member), member).toBe(false);
  expect(classes.get("FlippedNumber")!.base!.def.name).toBe("PairNumber");
  expect(classes.get("FlippedNumber")!.root.def.name).toBe("Root");
  expect(classMembershipIntervals(classes, "Flipped")).toHaveLength(3);
});

test.each(["i32", "i64"])(
  "class-value membership keeps disjoint family ranges on %s targets",
  (size) => {
    const classes = graph();
    const helper = emitClassMembershipHelper(classes, size).join("\n");
    expect(helper).toContain(`switch ${size} %pre`);
    expect(helper).toContain(`icmp uge ${size} %value`);
    expect(helper).toContain("label %ordinary");
    expect(helper).toContain("or i1");
    const ordinary: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "main",
      functions: [],
      classes: [
        { name: "Base", fields: [], methods: [], loc },
        { name: "Child", base: "Base", fields: [], methods: [], loc },
      ],
    };
    expect(emitClassMembershipHelper(buildClassGraph(ordinary, new Map()), size)).toEqual([]);
  },
);

test("unconstructed narrowing layouts may omit abstract slots while live classes require implementations", () => {
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Base", fields: [], methods: ["run"], abstractMethods: ["run"], abstract: true, loc },
      { name: "Dormant", base: "Base", fields: [], methods: [], loc },
    ],
  };
  const active = { kind: "object" as const, className: "Active" };
  mod.classes!.push({ name: "Active", base: "Base", fields: [], methods: ["run"], loc });
  mod.functions.push({
    name: "%Active.run",
    params: [{ localId: "self", name: "self", type: active }],
    returnType: VOID,
    locals: [{ id: "self", name: "self", type: active, mutable: false }],
    body: [],
    loc,
  });
  expect(emitLlvmModule(mod)).toMatch(/ptr null[^\n]*; class Dormant/);
  const self = { kind: "object" as const, className: "Dormant" };
  mod.functions.push({
    name: "%Dormant.constructor",
    params: [{ localId: "self", name: "self", type: self }],
    returnType: VOID,
    locals: [{ id: "self", name: "self", type: self, mutable: false }],
    body: [],
    loc,
  });
  expect(() => emitLlvmModule(mod)).toThrow("no implementation of run for Dormant");
});
