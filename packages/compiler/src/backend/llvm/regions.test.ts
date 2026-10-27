import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import {
  mangleClassNew,
  mangleClassRelease,
  mangleClassRetain,
  mangleClassStruct,
  mangleRecordRelease,
  mangleRecordStruct,
} from "../mangle.js";

const loc = { file: "regions.ts", start: 0, end: 1 };
const node: IrType = { kind: "object", className: "Node" };
const leaf: IrType = { kind: "object", className: "Leaf" };
const owner: IrType = { kind: "object", className: "Owner" };
const tagged: IrType = { kind: "object", className: "Tagged" };
const span: IrType = { kind: "record", shapeId: "span" };

/** A ProgramLifetime hierarchy (Node, Leaf), an ordinary hierarchy that
 * holds instances of it (Owner, Tagged), a record that holds one, and a
 * class that cannot reach any (Label). */
function module(body: IrExpr[] = [], lifetimeRegions = true): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    ...(lifetimeRegions ? { lifetimeRegions: true as const } : {}),
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: body.map((expr) => ({ kind: "exprStmt" as const, expr, loc })),
        loc,
      },
    ],
    classes: [
      {
        name: "Node",
        fields: [
          { name: "parent", type: node },
          { name: "kids", type: { kind: "array", elem: node } },
          { name: "name", type: STRING },
          { name: "span", type: span },
        ],
        methods: [],
        loc,
      },
      {
        name: "Leaf",
        base: "Node",
        fields: [
          { name: "parent", type: node },
          { name: "kids", type: { kind: "array", elem: node } },
          { name: "name", type: STRING },
          { name: "span", type: span },
          { name: "value", type: F64 },
        ],
        methods: [],
        loc,
      },
      { name: "Owner", fields: [{ name: "label", type: STRING }], methods: [], loc },
      {
        name: "Tagged",
        base: "Owner",
        fields: [
          { name: "label", type: STRING },
          { name: "target", type: leaf },
        ],
        methods: [],
        loc,
      },
      { name: "Label", fields: [{ name: "text", type: STRING }], methods: [], loc },
      { name: "Holder", fields: [{ name: "owner", type: owner }], methods: [], loc },
    ],
    records: [
      {
        id: "span",
        fields: [
          { name: "end", type: F64 },
          { name: "owner", type: tagged },
        ],
      },
    ],
    contracts: { programLifetime: ["Node"] },
  };
}

function body(llvm: string, name: string): string {
  return (
    new RegExp(`^define internal [a-z]+ @${name.replace(/[.$]/g, "\\$&")}\\([^]*?^}`, "m").exec(
      llvm,
    )?.[0] ?? ""
  );
}

test("programs without regions keep ProgramLifetime's empty counts and emit no region code", () => {
  const llvm = emitLlvmModule(module([], false), { pointerBits: 64 });
  expect(llvm).not.toMatch(/scr_region|sc_rgn_types|\.rcur|\.rcls|\.rvisit|\.rwalk|\.rown/);
  expect(body(llvm, mangleClassRetain("Node"))).toMatch(/entry:\n {2}ret ptr %o\n}/);
  expect(body(llvm, mangleClassRelease("Leaf"))).toMatch(/entry:\n {2}ret void\n}/);
});

test("ProgramLifetime instances live in the current region and count in their chunk", () => {
  const llvm = emitLlvmModule(module(), { pointerBits: 64 });
  for (const cls of ["Node", "Leaf"]) {
    const struct = mangleClassStruct(cls);
    // new: the cursor fast path, the runtime's slow path, and the
    // program-lifetime count publication still reads.
    const nw = body(llvm, mangleClassNew(cls));
    expect(nw, cls).toContain(`load ptr, ptr @${struct}.rcur`);
    expect(nw, cls).toContain(
      `call ptr @scr_region_alloc(ptr @${struct}.rcur, ptr @${struct}.rcls)`,
    );
    // The first reference is implied: allocation leaves the chunk count alone.
    expect(nw, cls).not.toContain("2097151");
    // The rc word: the class id in the high half (the hierarchy keeps it
    // there instead of a vtable word) over the program-lifetime count, the
    // midpoint of the 32-bit count in the low half.
    const word = /store i64 (\d+), ptr %o\.vt/.exec(nw)?.[1];
    expect(word, cls).toBeDefined();
    expect(BigInt(word!) % 2n ** 32n, cls).toBe(2n ** 31n);
    expect(BigInt(word!) / 2n ** 32n > 0n, cls).toBe(true);
    expect(nw, cls).not.toContain("scr_rt_calloc");
    // retain/release: the chunk count, NULL-tolerant, once a region
    // exists, and only in chunks that have an owner (freeable regions).
    expect(body(llvm, mangleClassRetain(cls)), cls).toMatch(
      /%on = load i8, ptr @scr_region_counting, !tbaa !\d+\n {2}%idle = icmp eq i8 %on, 0/,
    );
    expect(body(llvm, mangleClassRetain(cls)), cls).toContain("%mine = icmp ne ptr %owner, null");
    expect(body(llvm, mangleClassRetain(cls)), cls).toMatch(/add i64 %n, 1/);
    expect(body(llvm, mangleClassRelease(cls)), cls).toMatch(/sub i64 %n, 1/);
    expect(body(llvm, mangleClassRelease(cls)), cls).toContain("icmp eq ptr %o, null");
    expect(llvm, cls).toMatch(
      new RegExp(`@${struct}\\.rcur = internal global \\{ ptr, ptr \\} zeroinitializer`),
    );
  }
  // The visit reports region references by address, ordinary references
  // with the release entry point the runtime knows them by; strings cannot
  // reach the region and are not reported.
  const visit = body(llvm, `${mangleClassStruct("Leaf")}.rvisit`);
  expect(visit).toContain("call void @scr_region_ref(ptr %w, ptr %v0) ; parent");
  expect(visit).toContain(
    "call void @scr_region_slot(ptr %w, ptr %v1, ptr @scr_arr_release_v) ; kids",
  );
  expect(visit).toContain(
    `call void @scr_region_slot(ptr %w, ptr %v3, ptr @${mangleRecordRelease("span")}) ; span`,
  );
  expect(visit).not.toContain("; name");
  // The fields-release releases every reference field, strings included.
  const release = body(llvm, `${mangleClassStruct("Leaf")}.rrelease`);
  for (const field of ["parent", "kids", "name", "span"]) expect(release).toContain(`; ${field}`);
});

test("walkers cover the ordinary classes and records that can reach a region", () => {
  const llvm = emitLlvmModule(module(), { pointerBits: 64 });
  // Owner itself holds nothing, but a field typed Owner may hold a Tagged:
  // its walker dispatches on the dynamic class.
  const owner = body(llvm, `${mangleClassStruct("Owner")}.rwalk`);
  expect(owner).toMatch(/switch i64 %pre, label %done \[ i64 \d+, label %c\d+ \]/);
  expect(owner).toContain(`call void @${mangleClassStruct("Tagged")}.rown(ptr %o, ptr %w)`);
  expect(llvm).not.toContain(`@${mangleClassStruct("Owner")}.rown(`);
  expect(body(llvm, `${mangleClassStruct("Tagged")}.rown`)).toContain(
    "call void @scr_region_ref(ptr %w, ptr %v1) ; target",
  );
  expect(body(llvm, `${mangleRecordStruct("span")}.rwalk`)).toContain(
    `call void @scr_region_slot(ptr %w, ptr %v1, ptr @${mangleClassRelease("Tagged")}) ; owner`,
  );
  // Classes that cannot reach the region are not walked.
  expect(llvm).not.toContain(`${mangleClassStruct("Label")}.rwalk`);
  // The table: region classes by release, then walkers.
  const table = /^@sc_rgn_types = internal constant .*$/m.exec(llvm)?.[0] ?? "";
  expect(table).toContain(`{ ptr @${mangleClassRelease("Node")}, ptr null }`);
  expect(table).toContain(`{ ptr @${mangleClassRelease("Leaf")}, ptr null }`);
  expect(table).toContain(
    `{ ptr @${mangleClassRelease("Owner")}, ptr @${mangleClassStruct("Owner")}.rwalk }`,
  );
  expect(table).toContain(
    `{ ptr @${mangleClassRelease("Holder")}, ptr @${mangleClassStruct("Holder")}.rown }`,
  );
  expect(table).toContain(
    `{ ptr @${mangleRecordRelease("span")}, ptr @${mangleRecordStruct("span")}.rwalk }`,
  );
  expect(table).not.toContain(mangleClassRelease("Label"));
  expect(table).toMatch(/\{ ptr, ptr \} zeroinitializer \] ; region type table$/);
});

test("worker executables count only their own chunks", () => {
  const llvm = emitLlvmModule({ ...module(), workers: true }, { pointerBits: 64 });
  const retain = body(llvm, mangleClassRetain("Node"));
  expect(retain).toContain("load atomic i8, ptr @scr_region_counting unordered, align 1");
  expect(retain).toContain("call ptr @llvm.threadlocal.address.p0(ptr @scr_thread_hot)");
  expect(retain).toMatch(/icmp eq ptr %owner, %self\n {2}br i1 %mine, label %count, label %done/);
  expect(llvm).toMatch(/@sc_o_Node\.rcur = internal thread_local(\(localexec\))? global/);
});

test("LifetimeRegion's intrinsics call the runtime", () => {
  const id: IrExpr = { kind: "intrinsic", name: "region.create", args: [], type: F64, loc };
  const calls: IrExpr[] = [
    { kind: "intrinsic", name: "region.enter", args: [id], type: VOID, loc },
    { kind: "intrinsic", name: "region.leave", args: [], type: VOID, loc },
    { kind: "intrinsic", name: "region.release", args: [id], type: VOID, loc },
  ];
  expect(validateModule(module(calls))).toEqual([]);
  const llvm = emitLlvmModule(module(calls), { pointerBits: 64 });
  const main = body(llvm, "main") || llvm;
  expect(main).toMatch(/call double @scr_region_create\(ptr @sc_rgn_types\)/);
  expect(main).toMatch(/call void @scr_region_enter\(double %\S+\)/);
  expect(main).toContain("call void @scr_region_leave()");
  expect(main).toMatch(/call void @scr_region_release\(double %\S+\)/);
  // Region intrinsics need a module that uses regions.
  expect(validateModule(module(calls, false)).map((e) => e.message)).toContain(
    "in main: region.enter outside a lifetimeRegions module",
  );
});
