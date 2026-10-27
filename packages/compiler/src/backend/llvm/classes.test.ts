import { expect, test } from "vitest";
import {
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import {
  assignCompactLayouts,
  buildClassGraph,
  classFieldIndex,
  classIdLoadLines,
  classMembershipIntervals,
  emitClassMembershipHelper,
  type LlClassMeta,
} from "./classes.js";
import { emitLlvmModule, lowRegionTarget } from "./emitter.js";
import {
  mangleClassNew,
  mangleClassReleaseDirect,
  mangleClassRelease,
  mangleClassRetain,
  mangleClassStruct,
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

test("teardowns of types with children of their own type free their blocks as one segment", () => {
  const linked = { kind: "object" as const, className: "Linked" };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      {
        name: "Linked",
        // The array field keeps the recursive teardown: a type whose every
        // reference field holds its own type tears down in one loop
        // (iterative-teardown.test.ts).
        fields: [
          { name: "next", type: linked },
          { name: "other", type: linked },
          { name: "tags", type: { kind: "array", elem: { kind: "string" } } },
        ],
        methods: [],
        loc,
      },
    ],
    records: [{ id: "branch", fields: [{ name: "next", type: linked }] }],
  };
  const define = (llvm: string, name: string): string =>
    new RegExp(`^define internal [^@]*@${name}\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
  const linkedDestroy = `${mangleClassRelease("Linked")}_destroy`;
  const branchDestroy = `${mangleRecordRelease("branch")}_destroy`;
  for (const workers of [false, true]) {
    const llvm = emitLlvmModule({ ...mod, workers }, { pointerBits: 64 });
    // Linked's teardown keeps its block and its children's in a segment: it
    // releases its own block first and places it by address against its
    // first child, a child torn down directly appends to the segment, one
    // past the direct chain appends through the runtime, and the chain's
    // first teardown frees the segment onto the free list in one step.
    const seg = define(llvm, `${linkedDestroy}_s`);
    expect(seg.startsWith("define internal ptr"), "segment form").toBe(true);
    expect(seg).toMatch(
      /store ptr %(?:sf\.blk|o), ptr %sg\.own[^]*call ptr @sc_release_Linked_destroy_s\(/,
    );
    // The children's releases have a copy for each place of the own block.
    for (const copy of ["ta", "tb"])
      expect(seg).toContain(
        `call ptr @scr_rc_destroy_seg(ptr %v0, ptr @${linkedDestroy}_sc, ptr @${linkedDestroy}, ptr %${copy}0.bt)`,
      );
    expect(seg).not.toContain("call void @scr_rc_destroy(");
    expect(seg).toContain("icmp ult ptr %sg.o, %sg.r1");
    const first = define(llvm, `${linkedDestroy}_d`);
    expect(first).toContain(`call ptr @${linkedDestroy}_s(ptr %o, i32 %d, ptr %head)`);
    expect(first).toContain("store ptr %first, ptr %sgf.fp");
    expect(first.includes("llvm.threadlocal.address"), "thread-local state").toBe(workers);
    expect(define(llvm, linkedDestroy)).toContain(`call void @${linkedDestroy}_d(ptr %o, i32 0)`);
    // A record whose child is another type frees its own block as before.
    expect(define(llvm, `${branchDestroy}_s`)).toBe("");
    expect(define(llvm, branchDestroy)).toContain(`call void @${mangleClassRelease("Linked")}(`);
  }
  // Without the inline allocation paths (32-bit targets) a teardown frees
  // through the runtime, block by block.
  const llvm32 = emitLlvmModule(mod, { pointerBits: 32 });
  expect(define(llvm32, `${linkedDestroy}_s`)).toBe("");
  expect(define(llvm32, `${linkedDestroy}_d`)).toContain(`call void @${linkedDestroy}_d(`);
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
  // A hierarchy rooted in the program: a surviving release decrements the
  // count (the low half of the rc word, which keeps the class id in its high
  // half) and takes the possible-root step without loading the vtable.
  const fast = body(mangleClassRelease("Node"));
  expect(fast).toContain("%shared = icmp ult i32 %rcm2, -3");
  expect(fast).toContain("load i32, ptr %bufp");
  expect(fast).toContain(`call void @${mangleClassRelease("Node")}_slow(ptr %o)`);
  expect(fast).not.toContain("%ScrVt");
  // Only the last reference dispatches, from a noinline remainder.
  const slow = body(`${mangleClassRelease("Node")}_slow`);
  expect(slow).toMatch(/noinline/);
  // The class id indexes the hierarchy's vtable array.
  expect(slow).toContain("%vt.id = load i32, ptr %vt.idp");
  expect(slow).toContain("ptr @sc_vta_Node, i64 0, i64 %vt.ix64");
  expect(slow).toContain("getelementptr inbounds %ScrVt, ptr %vt, i64 0, i32 2");
  // 32-bit targets keep the vtable word.
  const wasm = emitLlvmModule(mod, { pointerBits: 32 });
  expect(wasm).toContain("; class Node (vt at 1)");
  expect(wasm).not.toContain("@sc_vta_Node");
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
    // 32-bit header: the tag 0x70000000 and the class id (Node's preorder
    // number 0 + 1, Leaf's 1 + 1), without a count.
    const nw = body(mangleClassNew(cls));
    const id = cls === "Node" ? 1 : 2;
    expect(nw, cls).toContain(`store i32 ${0x70000000 + id}, ptr %o.vt`);
    expect(nw, cls).not.toContain("store i64");
    expect(nw, cls).not.toContain("scr_cyc_alloc");
    expect(llvm, cls).not.toContain(`@${mangleClassTrace(cls)}.cyctype`);
    // The RC audit (sanitize builds) learns that the program keeps
    // program-lifetime objects; other builds emit nothing for it.
    expect(nw, cls).toContain("call void @scr_obj_lifetime_note(ptr %o)");
  }
  expect(llvm).toContain(`%${mangleClassStruct("Leaf")} = type { i32, ptr }`);
  const plain = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false });
  expect(plain).not.toContain("scr_obj_lifetime_note");
  // The mortal Owner keeps its header, counts and possible-root step.
  expect(body(mangleClassNew("Owner"))).toContain("store i64 1, ptr %o");
  expect(body(mangleClassNew("Owner"))).toContain("scr_cyc_alloc");
  expect(body(mangleClassRelease("Owner"))).toContain("load i32, ptr %bufp");
});

test("arrays of ProgramLifetime instances tell the runtime their teardown releases nothing", () => {
  const kids = { kind: "array" as const, elem: { kind: "object" as const, className: "Node" } };
  const owners = { kind: "array" as const, elem: { kind: "object" as const, className: "Owner" } };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [
          { kind: "exprStmt", expr: { kind: "arrayLit", elems: [], type: kids, loc }, loc },
          { kind: "exprStmt", expr: { kind: "arrayLit", elems: [], type: owners, loc }, loc },
        ],
        loc,
      },
    ],
    classes: [
      { name: "Node", fields: [], methods: [], loc },
      { name: "Owner", fields: [{ name: "nodes", type: kids }], methods: [], loc },
    ],
    contracts: { programLifetime: ["Node"] },
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const ops = (cls: string): string =>
    new RegExp(`^@sc_arrops\\.[^\\n]*${mangleClassRelease(cls)}[^\\n]*$`, "m").exec(llvm)?.[0] ??
    "";
  // SCR_ARR_OPS_RELEASE_NOTHING for Node; Owner's elements are released.
  expect(ops("Node")).toMatch(
    /= internal global \{ ptr, ptr, ptr, i32, i32 \} .*, i32 0, i32 2 \}$/,
  );
  expect(ops("Owner")).toMatch(/= internal global %ScrArrOps .*, i32 0 \}$/);
});

test("classes whose trace visits nothing start acyclic in a traced hierarchy", () => {
  const mapper = { kind: "object" as const, className: "Mapper" };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Mapper", fields: [], methods: [], loc },
      // A dyn field can reach anything: the hierarchy carries collector headers.
      {
        name: "Linked",
        base: "Mapper",
        fields: [
          { name: "next", type: mapper },
          { name: "hook", type: DYN },
        ],
        methods: [],
        loc,
      },
      { name: "Simple", base: "Mapper", fields: [{ name: "value", type: F64 }], methods: [], loc },
    ],
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const body = (name: string): string =>
    new RegExp(`^define internal [a-z]+ @${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
  const descriptor = (cls: string): string =>
    llvm.split("\n").find((line) => line.startsWith(`@${mangleClassTrace(cls)}.cyctype = `)) ?? "";
  expect(descriptor("Simple")).toContain("{ ptr @scr_cyc_no_children, ");
  expect(body(mangleClassNew("Simple"))).toContain("store i32 -1, ptr %sa.bufp");
  expect(descriptor("Linked")).toContain(`{ ptr @${mangleClassTrace("Linked")}, `);
  expect(body(mangleClassNew("Linked"))).toContain("store i32 0, ptr %sa.bufp");
  // Releases share the hierarchy's possible-root step, which skips the
  // call for SCR_CYC_ACYCLIC, and a death unbuffers only below -1.
  expect(body(mangleClassRelease("Simple"))).toContain("icmp slt i32 %buf, 0");
  expect(body(mangleClassReleaseDirect("Simple"))).toContain("icmp slt i32 %dbuf, -1");
});

test("ProgramLifetime classes pack their fields after a 32-bit header", () => {
  const BOOL = { kind: "bool" as const };
  const nodeFields = [
    { name: "parent", type: STRING },
    { name: "flag", type: BOOL },
    { name: "weight", type: F64 },
  ];
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Node", fields: nodeFields, methods: [], loc },
      {
        name: "Leaf",
        base: "Node",
        fields: [...nodeFields, { name: "next", type: STRING }, { name: "mark", type: BOOL }],
        methods: [],
        loc,
      },
    ],
    contracts: { programLifetime: ["Node"] },
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  // Scalars narrower than 8 bytes go first, then the rest, widest first,
  // each at the first offset that fits it. Node's weight (an int32 slot:
  // nothing stores a fraction) takes the word the header shares and its
  // flag the next one (24 bytes, not 32); Leaf keeps Node's offsets and puts
  // its bool next to Node's (32 bytes, not 48).
  expect(llvm).toContain(`%${mangleClassStruct("Node")} = type { i32, i32, i8, ptr }`);
  expect(llvm).toContain(`%${mangleClassStruct("Leaf")} = type { i32, i32, i8, i8, ptr, ptr }`);
  // Without the contract, the layout is the declared one.
  const mortal = emitLlvmModule({ ...mod, contracts: {} }, { pointerBits: 64 });
  expect(mortal).toContain(`%${mangleClassStruct("Leaf")} = type { i64, ptr, i8, i32, ptr, i8 }`);
});

test("references between ProgramLifetime instances are 32-bit indexes into their region", () => {
  const node = { kind: "object" as const, className: "Node" };
  const leaf = { kind: "object" as const, className: "Leaf" };
  const root = { localId: "root", name: "root", type: leaf };
  const nodeFields = [{ name: "parent", type: node }];
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [root],
        returnType: VOID,
        locals: [{ id: "root", name: "root", type: leaf, mutable: false }],
        body: [
          {
            kind: "fieldSet",
            obj: { kind: "varRef", localId: "root", type: leaf, loc },
            className: "Leaf",
            field: "parent",
            value: {
              kind: "fieldGet",
              obj: { kind: "varRef", localId: "root", type: leaf, loc },
              className: "Leaf",
              field: "next",
              type: leaf,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
    classes: [
      { name: "Node", fields: nodeFields, methods: [], loc },
      {
        name: "Leaf",
        base: "Node",
        fields: [...nodeFields, { name: "next", type: leaf }, { name: "label", type: STRING }],
        methods: [],
        loc,
      },
    ],
    contracts: { programLifetime: ["Node"] },
  };
  // Linux executables without sanitizers (lowRegionTarget).
  const llvm = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false, lowRegion: true });
  // parent and next take 4 bytes each; the string keeps its pointer.
  expect(llvm).toContain(`%${mangleClassStruct("Node")} = type { i32, i32 }`);
  expect(llvm).toContain(`%${mangleClassStruct("Leaf")} = type { i32, i32, ptr, i32 }`);
  // Instances come from the region, reserved below 32 GiB before compiled
  // code runs: a bump of the thread's chunk, and the runtime when it is used
  // up.
  const nw =
    new RegExp(`^define internal ptr @${mangleClassNew("Leaf")}\\([^]*?^}`, "m").exec(llvm)?.[0] ??
    "";
  expect(nw).toContain("%plr.end = getelementptr i8, ptr %plr.next");
  expect(nw).toContain("store ptr %plr.end, ptr %plr.c");
  expect(nw).toMatch(/%plr.o = call ptr @scr_plr_alloc\(i64 /);
  expect(llvm).toMatch(/call void @scr_init\(\)\n {2}call void @scr_plr_init\(\)/);
  // A reference is the instance's address over 8 (0 is NULL): a read
  // shifts the loaded word, a write shifts the pointer.
  const main = llvm.split(/^define /m).find((fn) => fn.includes("; main\n")) ?? "";
  expect(main).toMatch(/= load i32, ptr %\S+, !tbaa/);
  expect(main).toMatch(/= shl nuw nsw i64 %\S+, 3\n\s+%\S+ = inttoptr i64 %\S+ to ptr/);
  expect(main).toMatch(/= ptrtoint ptr %\S+ to i64\n\s+%\S+ = lshr i64 %\S+, 3/);
  expect(main).toMatch(/store i32 %\S+, ptr %\S+/);
  expect(main).not.toContain("select");
  expect(lowRegionTarget("linux", false)).toBe(true);
  expect(lowRegionTarget("linux", true)).toBe(false);
  expect(lowRegionTarget("darwin", false)).toBe(false);
  expect(lowRegionTarget("win32", false)).toBe(false);
  // Other targets, 32-bit targets and mortal classes keep pointers.
  const elsewhere = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false });
  expect(elsewhere).toContain(`%${mangleClassStruct("Leaf")} = type { i32, ptr, ptr, ptr }`);
  expect(elsewhere).not.toContain("scr_plr");
  const llvm32 = emitLlvmModule(mod, { pointerBits: 32, lowRegion: true });
  expect(llvm32).not.toContain("scr_plr");
  const mortal = emitLlvmModule({ ...mod, contracts: {} }, { pointerBits: 64, lowRegion: true });
  expect(mortal).not.toContain("scr_plr");
  // Field accessors that read the storage as a pointer are refused.
  const metas = buildClassGraph(mod, new Map());
  assignCompactLayouts(
    metas,
    () => true,
    (cls) => cls.fields.map(() => "ptr"),
    (cls, i, isCompact) => {
      const t = cls.fields[i]!.type;
      return t.kind === "object" && isCompact(t.className);
    },
  );
  const leafMeta = metas.get("Leaf")!;
  expect(() => classFieldIndex(leafMeta, "next")).toThrow(/holds a 32-bit reference/);
  expect(classFieldIndex(leafMeta, "next", "compressed").compressed).toBe(true);
  expect(classFieldIndex(leafMeta, "label").compressed).toBe(false);
});

test("arrays of ProgramLifetime instances keep 32-bit references in 4-byte slots", () => {
  const node = { kind: "object" as const, className: "Node" };
  const nodes = { kind: "array" as const, elem: node };
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const fn = (name: string, body: IrExpr, returnType: IrType): IrFunction => ({
    name,
    params: [
      { name: "a", localId: "a", type: nodes },
      { name: "v", localId: "v", type: node },
    ],
    returnType,
    locals: [
      { id: "a", name: "a", type: nodes, mutable: false },
      { id: "v", name: "v", type: node, mutable: false },
    ],
    body: [{ kind: "return", value: body, loc }],
    loc,
  });
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn(
        "first",
        {
          kind: "arrayGet",
          arr: ref("a", nodes),
          index: { kind: "numLit", value: 0, type: F64, loc },
          type: node,
          loc,
        },
        node,
      ),
      fn(
        "add",
        {
          kind: "arrIntrinsic",
          method: "push",
          receiver: ref("a", nodes),
          args: [ref("v", node)],
          type: F64,
          loc,
        },
        F64,
      ),
      fn("make", { kind: "arrayLit", elems: [ref("v", node)], type: nodes, loc }, nodes),
      fn(
        "find",
        {
          kind: "arrIntrinsic",
          method: "indexOf",
          receiver: ref("a", nodes),
          args: [ref("v", node)],
          type: F64,
          loc,
        },
        F64,
      ),
    ],
    classes: [{ name: "Node", fields: [{ name: "kids", type: nodes }], methods: [], loc }],
    contracts: { programLifetime: ["Node"] },
  };
  const body = (llvm: string, name: string): string =>
    llvm.split(/^define /m).find((f) => f.includes(`; ${name}\n`)) ?? "";
  const llvm = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false, lowRegion: true });
  // The element type's ops say so (SCR_ARR_OPS_COMPACT), so the runtime makes
  // the arrays SCR_ELEM_CREF.
  expect(llvm).toMatch(
    /^@sc_arrops\.\S+\.c = internal global \{ ptr, ptr, ptr, i32, i32 \} \{ [^}]*, i32 0, i32 1 \}$/m,
  );
  // A read loads the 32-bit reference and shifts it; an append stores one.
  const first = body(llvm, "first");
  expect(first).toMatch(/getelementptr inbounds i32, ptr %\S+, i64 \S+\n\s+%\S+ = load i32/);
  // The states follow 4-byte slots.
  expect(first).toContain("getelementptr inbounds [5 x i8]");
  expect(first).toMatch(/= inttoptr i64 %\S+ to ptr/);
  expect(body(llvm, "add")).toMatch(
    /= lshr i64 %\S+, 3\n\s+%\S+ = trunc i64 %\S+ to i32\n\s+store i32/,
  );
  // indexOf scans the 4-byte slots for the needle's reference.
  expect(llvm).toMatch(/call double @sc_arr_index_of_cref\(ptr %\S+, ptr %\S+\)/);
  expect(/^define internal double @sc_arr_index_of_cref[^]*?^}/m.exec(llvm)?.[0]).toContain(
    "load i32, ptr %qp0",
  );
  // Elsewhere the arrays keep 8-byte slots.
  const elsewhere = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false });
  expect(elsewhere).not.toMatch(/sc_arrops\.\S+\.c /);
  expect(body(elsewhere, "first")).not.toContain("inttoptr");
  expect(elsewhere).not.toContain("sc_arr_index_of_cref");
});

test("a recycled block is cleared from the end of a ProgramLifetime instance's 32-bit header", () => {
  const BOOL = { kind: "bool" as const };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Marker", fields: [], methods: [], loc },
      { name: "Toggle", fields: [{ name: "on", type: BOOL }], methods: [], loc },
    ],
    contracts: { programLifetime: ["Marker", "Toggle"] },
  };
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  for (const name of ["Marker", "Toggle"]) {
    const start = llvm.indexOf(`define internal ptr @${mangleClassNew(name)}(`);
    const body = llvm.slice(start, llvm.indexOf("\n}\n", start));
    // The constructor stores the 4-byte header itself; a 4-byte instance
    // (Marker) clears nothing, and Toggle's field at offset 4 is cleared.
    expect(body).toContain("%sa.z = getelementptr inbounds i8, ptr %sa.b, i64 4");
    expect(body).toContain("%sa.zn = sub i64 %sa.n, 4");
    expect(body).toContain("call void @llvm.memset.p0.i64(ptr align 4 %sa.z,");
  }
});

test("invariant class id reads of compact instances leave out the published bit", () => {
  const group = ", !invariant.group !{}";
  const compact = (post: number) => ({ compact: true, root: { post } }) as unknown as LlClassMeta;
  // Publication sets the header word's top bit; ids below 2^16 are read
  // from the low 16 bits, which never change after construction.
  expect(classIdLoadLines(compact(40), "%o", "%id", group)).toEqual([
    "  %id.h = load i16, ptr %o, !invariant.group !{}",
    "  %id = zext i16 %id.h to i32",
  ]);
  // Wider ids, and reads without the metadata, mask the whole word.
  const masked = ["  %id.w = load i32, ptr %o", "  %id = and i32 %id.w, 268435455"];
  expect(classIdLoadLines(compact(0xffff), "%o", "%id", group)).toEqual(masked);
  expect(classIdLoadLines(compact(40), "%o", "%id", "")).toEqual(masked);
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
  // The walker marks each instance by the top bit of its 32-bit header,
  // logging the word so a refusal restores it; untraced, so it never leaves
  // a collector buffer.
  expect(llvm).toContain("call void @scr_publish(ptr");
  // Kind 4 (an object) | 0x200 (the 32-bit header: the mark sets its top
  // bit).
  expect(llvm).toMatch(/@scr_pub_mark\(ptr %ctx, ptr %o, i1 false, i32 516\)/);
  const plain = emitLlvmModule(mod, { pointerBits: 64, objectAudit: false });
  expect(plain).toContain("%mpub = or i32 %mrc, -2147483648");
  // Pushing a reference skips one published before: a set top bit.
  expect(llvm).toMatch(/%immortal0 = icmp slt i32 %rc0, 0/);
  // The walker dispatches on the class id in the header's low 28 bits.
  expect(llvm).toContain("%id = and i32 %idw, 268435455");
  // The frozen-object guard of the store tests the top bit: an unpublished
  // instance stays writable.
  const store =
    llvm.split(/^define /m).find((fn) => fn.includes("call void @scr_throw_published_field(")) ??
    "";
  expect(store).toMatch(/icmp slt i32 %\S+, 0/);
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

test("the young-in nursery flag adds the nursery entry to traced constructors only", () => {
  const linked = { kind: "object" as const, className: "Linked" };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
    classes: [
      { name: "Scalar", fields: [{ name: "value", type: F64 }], methods: [], loc },
      // A dyn field can reach anything: the class carries a collector header.
      {
        name: "Linked",
        fields: [
          { name: "next", type: linked },
          { name: "hook", type: DYN },
        ],
        methods: [],
        loc,
      },
    ],
  };
  const helper = (llvm: string, name: string): string => {
    const start = llvm.indexOf(`define internal ptr @${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return llvm.slice(start, llvm.indexOf("\n}\n", start));
  };
  const saved = process.env["SCRIPTC_YOUNG_NURSERY"];
  try {
    delete process.env["SCRIPTC_YOUNG_NURSERY"];
    const off = emitLlvmModule(mod, { pointerBits: 64 });
    expect(off).not.toContain("scr_yin");

    process.env["SCRIPTC_YOUNG_NURSERY"] = "1";
    const on = emitLlvmModule(mod, { pointerBits: 64 });
    const linkedNew = helper(on, mangleClassNew("Linked"));
    expect(linkedNew).toContain("@scr_yin_skip");
    expect(linkedNew).toContain("call void @scr_yin_enter_slow(ptr %o)");
    expect(linkedNew).toContain("store i8 3, ptr %ye.genp");
    // An acyclic class has no collector header and never enters.
    expect(helper(on, mangleClassNew("Scalar"))).not.toContain("scr_yin");
    // Targets without the inline allocator call the whole entry.
    const narrow = emitLlvmModule(mod, { pointerBits: 32 });
    expect(helper(narrow, mangleClassNew("Linked"))).toContain("call void @scr_yin_enter(ptr %o)");
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_YOUNG_NURSERY"];
    else process.env["SCRIPTC_YOUNG_NURSERY"] = saved;
  }
});
