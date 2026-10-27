import { describe, expect, test } from "vitest";
import { F64, type IrModule, RUNTIME_EMITTER_CLASS } from "../../ir/ir.js";
import {
  boxReleaseSym,
  emitInlineRcHelpers,
  emitRecordShapes,
  inlineRcDecls,
  INLINE_DYN_RELEASES_PER_FUNCTION,
  INLINE_STR_RELEASES_PER_FUNCTION,
  inlineRcOption,
  limitInlineReleases,
  releaseSym,
  retainSym,
  type ShapeHost,
  vAdapters,
} from "./shapes.js";
import { mangleRecordRelease } from "../mangle.js";
import { NullableUnions } from "./nullable-unions.js";
import { InlineUnionFields } from "./inline-unions.js";

function declarationHost(
  pointerBits: 32 | 64 = 64,
  inlineRc: boolean | "release" = false,
): { host: ShapeHost; declarations: string[] } {
  const declarations: string[] = [];
  const host: ShapeHost = {
    declare(decl) {
      declarations.push(decl);
    },
    needOom() {},
    mapOps: (operands) => (operands.every((op) => op === "null") ? "null" : "@sc_map_ops"),
    sizeType: pointerBits === 32 ? "i32" : "i64",
    cycleBufOffset: 4,
    tracedShapes: new Set(),
    tracedUnions: new Set(),
    nullableUnions: new NullableUnions({
      irVersion: 17,
      sourceFile: "test.ts",
      functions: [],
      entry: "main",
    }),
    inlineUnions: new InlineUnionFields(new Map()),
    unionNoneRef: () => "@sc_union_none",
    recordsById: new Map(),
    recordCloneShapes: new Set(),
    rcHelpers: inlineRc ? new Set() : null,
    ...(inlineRc
      ? { rcMode: inlineRc === "release" ? ("release" as const) : ("speed" as const) }
      : {}),
  };
  return { host, declarations };
}

describe("LLVM runtime RC symbols", () => {
  test("derives adapter declarations from the shared stems", () => {
    const { host, declarations } = declarationHost();
    expect(vAdapters(host, { kind: "netSocket" })).toEqual({
      retain: "@scr_net_sock_retain_v",
      release: "@scr_net_sock_release_v",
    });
    expect(declarations).toEqual([
      "declare ptr @scr_net_sock_retain_v(ptr)",
      "declare void @scr_net_sock_release_v(ptr)",
    ]);
  });

  test("uses typed releases and preserves ABI exceptions", () => {
    const { host, declarations } = declarationHost();
    expect(releaseSym(host, { kind: "url" })).toBe("@scr_url_release");
    expect(releaseSym(host, { kind: "classval", className: "Widget" })).toBe(
      "@scr_classobj_release_v",
    );
    expect(vAdapters(host, { kind: "caught" })).toEqual({
      retain: "@scr_caught_retain",
      release: "@scr_caught_release",
    });
    expect(declarations).toContain("declare void @scr_url_release(ptr)");
  });

  test("keeps runtime and emitted object families distinct", () => {
    const { host } = declarationHost();
    expect(vAdapters(host, { kind: "object", className: RUNTIME_EMITTER_CLASS })).toEqual({
      retain: "@scr_emitter_retain_v",
      release: "@scr_emitter_release_v",
    });
    expect(vAdapters(host, { kind: "object", className: "Widget" })).toEqual({
      retain: "@sc_retain_Widget",
      release: "@sc_release_Widget",
    });
  });

  test("release emission keeps every retain and release a runtime call", () => {
    const { host, declarations } = declarationHost();
    expect(retainSym(host, { kind: "string" })).toBe("@scr_str_retain_v");
    expect(releaseSym(host, { kind: "string" })).toBe("@scr_str_release");
    expect(releaseSym(host, { kind: "union", unionId: "u0" } as never)).toBe("@scr_union_release");
    expect(boxReleaseSym(host)).toBe("@scr_box_release");
    expect(declarations).toContain("declare void @scr_box_release(ptr)");
    expect(inlineRcDecls(host)).toEqual([]);
    expect(emitInlineRcHelpers(host)).toEqual([]);
  });

  test("routes mirrored families through inline fast-path helpers", () => {
    const { host, declarations } = declarationHost(64, true);
    expect(retainSym(host, { kind: "string" })).toBe("@sc_rc_retain_str");
    expect(releaseSym(host, { kind: "string" })).toBe("@sc_rc_release_str");
    expect(releaseSym(host, { kind: "set", elem: { kind: "f64" } } as never)).toBe(
      "@sc_rc_release_map",
    );
    expect(releaseSym(host, { kind: "union", unionId: "u0" } as never)).toBe(
      "@sc_rc_release_union",
    );
    const array = { kind: "array", elem: { kind: "string" } } as never;
    expect(retainSym(host, array)).toBe("@sc_rc_retain_arr");
    expect(releaseSym(host, array)).toBe("@sc_rc_release_arr");
    expect(retainSym(host, { kind: "dyn" })).toBe("@sc_rc_retain_dyn");
    expect(releaseSym(host, { kind: "dyn" })).toBe("@sc_rc_release_dyn");
    // Unmirrored families and caught snapshots keep their runtime entry points.
    expect(retainSym(host, { kind: "url" })).toBe("@scr_url_retain_v");
    expect(retainSym(host, { kind: "caught" })).toBe("@scr_caught_retain");
    // Container function pointers keep the runtime symbols (identity tests).
    expect(vAdapters(host, { kind: "dyn" }).retain).toBe("@scr_dyn_retain_v");
    expect(vAdapters(host, { kind: "string" }).release).toBe("@scr_str_release_v");
    expect(declarations).toContain("declare void @scr_str_release(ptr)");
    expect(declarations).toContain("declare void @scr_cyc_on_release(ptr)");
    expect(inlineRcDecls(host).sort()).toEqual([
      "declare void @scr_arr_release(ptr)",
      "declare void @scr_cyc_on_release(ptr)",
      "declare void @scr_dyn_release(ptr)",
      "declare void @scr_dyn_release_survivor(ptr)",
      "declare void @scr_map_release(ptr)",
      "declare void @scr_str_release(ptr)",
      "declare void @scr_union_release(ptr)",
    ]);
  });

  test("release builds inline only string and dyn retains and releases and Map retains", () => {
    const { host } = declarationHost(64, "release");
    expect(retainSym(host, { kind: "string" })).toBe("@sc_rc_retain_str");
    expect(releaseSym(host, { kind: "string" })).toBe("@sc_rc_release_str");
    expect(retainSym(host, { kind: "dyn" })).toBe("@sc_rc_retain_dyn");
    expect(releaseSym(host, { kind: "dyn" })).toBe("@sc_rc_release_dyn");
    expect(releaseSym(host, { kind: "union", unionId: "u0" } as never)).toBe("@scr_union_release");
    const array = { kind: "array", elem: { kind: "string" } } as never;
    expect(retainSym(host, array)).toBe("@scr_arr_retain_v");
    // The dyn fast path buffers surviving values by kind, as scr_dyn_release does.
    const ir = emitInlineRcHelpers(host).join("\n");
    expect(ir).toContain("call void @scr_dyn_release_survivor(ptr %o)");
    // Every kind that can be a candidate takes one path; scalars stay inline.
    expect(ir).toContain(
      "switch i32 %kind, label %done [ i32 4, label %candidate i32 5, label %candidate i32 8, label %candidate i32 9, label %candidate i32 12, label %candidate i32 13, label %candidate ]",
    );
    // Values not yet buffered ask the runtime, which decides per value.
    expect(ir).toMatch(/br i1 %cqueued, label %done, label %survivor/);
    // The runtime buffers dyn candidates, so the dyn helper has no inline append.
    const dynHelper = ir.slice(
      ir.indexOf("@sc_rc_release_dyn("),
      ir.indexOf("\n}", ir.indexOf("@sc_rc_release_dyn(")),
    );
    expect(dynHelper).not.toContain("sc_cyc_append");
    expect(dynHelper).not.toContain("scr_cyc_on_release");
  });

  test("sanitized builds call the fast-path helpers out of line", () => {
    expect(inlineRcOption("release", true)).toEqual({
      inlineRc: "release",
      rcHelpersNoinline: true,
    });
    expect(inlineRcOption("release")).toEqual({ inlineRc: "release" });
    expect(inlineRcOption("dev", true)).toEqual({});
    const { host } = declarationHost(64, "release");
    const outOfLine: ShapeHost = { ...host, rcHelpersNoinline: true };
    retainSym(outOfLine, { kind: "dyn" });
    releaseSym(outOfLine, { kind: "dyn" });
    const ir = emitInlineRcHelpers(outOfLine).join("\n");
    expect(ir).toMatch(/define internal ptr @sc_rc_retain_dyn\(ptr %o\) noinline /);
    expect(ir).toMatch(/define internal void @sc_rc_release_dyn\(ptr %o\) noinline /);
  });

  test("mirrors the C fast paths and header offsets", () => {
    const { host } = declarationHost(64, true);
    retainSym(host, { kind: "string" });
    releaseSym(host, { kind: "string" });
    retainSym(host, { kind: "array", elem: { kind: "string" } } as never);
    releaseSym(host, { kind: "map", key: { kind: "string" }, value: { kind: "f64" } } as never);
    releaseSym(host, { kind: "union", unionId: "u0" } as never);
    retainSym(host, { kind: "promise", inner: { kind: "f64" } } as never);
    const ir = emitInlineRcHelpers(host).join("\n");
    const fn = (name: string): string => {
      const start = ir.indexOf(`@${name}(`);
      expect(start).toBeGreaterThan(-1);
      return ir.slice(start, ir.indexOf("\n}", start));
    };
    // Strings: no NULL test on retain (scr_str_retain dereferences), no header.
    expect(fn("sc_rc_retain_str")).not.toContain("null");
    expect(fn("sc_rc_retain_str")).not.toContain("store i32");
    expect(fn("sc_rc_release_str")).toContain("icmp eq i64 %rc, 1");
    expect(fn("sc_rc_release_str")).toContain("call void @scr_str_release(ptr %o) cold");
    expect(fn("sc_rc_release_str")).not.toContain("scr_cyc_on_release");
    // Retains never touch the cycle header, headered or not.
    expect(fn("sc_rc_retain_arr")).not.toContain("%ScrArr");
    expect(fn("sc_rc_retain_arr")).not.toContain("store i32");
    // Maps: a headered map's release is the runtime's; no inline buffering.
    expect(fn("sc_rc_release_map")).toContain("%ScrMapRc, ptr %o, i32 0, i32 3");
    expect(fn("sc_rc_release_map")).toContain("br i1 %headered, label %slow, label %dec");
    expect(fn("sc_rc_release_map")).not.toContain("store i32 1");
    // Unions: no color store, only the sign of the i32 `buf` at obj-4.
    expect(fn("sc_rc_release_union")).not.toContain("store i32");
    expect(fn("sc_rc_release_union")).toContain("getelementptr i8, ptr %o, i64 -4");
    expect(fn("sc_rc_release_union")).toContain("load i32, ptr %bufp");
    expect(fn("sc_rc_release_union")).toContain("icmp slt i32 %buf, 0");
    expect(fn("sc_rc_release_union")).toContain("call void @scr_cyc_on_release(ptr %o)");
    // Promises tolerate NULL and always carry a header.
    expect(fn("sc_rc_retain_promise")).toContain("icmp eq ptr %o, null");
    expect(fn("sc_rc_retain_promise")).not.toContain("store i32");
  });

  test("optimized builds buffer candidates through the module's append helper", () => {
    const emit = (inlineRc: true | "release", extra: Partial<ShapeHost>, kind: "union" | "dyn") => {
      const { host } = declarationHost(64, inlineRc);
      const configured: ShapeHost = { ...host, inlineAlloc: true, ...extra };
      releaseSym(configured, kind === "union" ? ({ kind, unionId: "u0" } as never) : { kind });
      return {
        ir: emitInlineRcHelpers(configured).join("\n"),
        decls: inlineRcDecls(configured),
      };
    };
    const { ir, decls } = emit(true, {}, "union");
    expect(ir).toContain("call preserve_mostcc void @sc_cyc_append(ptr %o)");
    expect(ir).toContain("define internal preserve_mostcc void @sc_cyc_append(ptr %o) noinline");
    // The young test reads the generation byte at obj-5; the append fills
    // scr_cyc_buffers' nursery buffer and the header's position at obj-4.
    expect(ir).toContain("getelementptr i8, ptr %o, i64 -5");
    expect(ir).toContain("getelementptr inbounds i8, ptr @scr_cyc_buffers, i64 96");
    expect(ir).toContain("getelementptr inbounds i8, ptr @scr_cyc_buffers, i64 104");
    expect(ir).toContain("load i64, ptr @scr_cyc_live");
    expect(ir).toContain("or i32 %i, -2147483648");
    expect(ir).toContain("call void @scr_cyc_on_release(ptr %o)");
    expect(decls).toContain(
      "@scr_cyc_buffers = external global { [3 x { ptr, i64, i64, i64 }], i64, i64 }",
    );
    expect(decls).toContain("@scr_cyc_live = external global i64");
    // The dyn release buffers through scr_dyn_release_survivor, so a module
    // whose only headered release is dyn's has no append helper.
    for (const mode of [true, "release"] as const) {
      const dyn = emit(mode, {}, "dyn");
      expect(dyn.ir).not.toContain("sc_cyc_append");
      expect(dyn.ir).not.toContain("scr_cyc_on_release");
      expect(dyn.decls.join("\n")).not.toContain("scr_cyc_buffers");
    }
    // Worker executables and targets without inline allocation call
    // scr_cyc_on_release, which tries the same append first.
    for (const extra of [{ threadLocalAlloc: true }, { inlineAlloc: false }]) {
      const { ir, decls } = emit(true, extra, "union");
      expect(ir).not.toContain("sc_cyc_append");
      expect(ir).toContain("call void @scr_cyc_on_release(ptr %o)");
      expect(decls.join("\n")).not.toContain("scr_cyc_buffers");
    }
  });

  test("uses the wasm32 header offsets", () => {
    const { host } = declarationHost(32, true);
    releaseSym(host, { kind: "union", unionId: "u0" } as never);
    const ir = emitInlineRcHelpers(host).join("\n");
    expect(ir).toContain("load i32, ptr %o");
    expect(ir).toContain("getelementptr i8, ptr %o, i32 -4");
  });
});

describe("inline release budgets", () => {
  const body = (name: string, sites: number, family = "dyn"): string =>
    [
      `define internal void @${name}(ptr %v) #0 {`,
      "entry:",
      ...Array.from({ length: sites }, () => `  call void @sc_rc_release_${family}(ptr %v)`),
      "  ret void",
      "}",
      "",
    ].join("\n");

  test("a function over the budget calls the runtime release at every site", () => {
    const small = body("small", INLINE_DYN_RELEASES_PER_FUNCTION);
    const large = body("large", INLINE_DYN_RELEASES_PER_FUNCTION + 1);
    // main's lines are separate parts.
    const limited = limitInlineReleases([`; header\n${small}`, ...large.split("\n")], "speed").join(
      "\n",
    );
    expect(limited.startsWith("; header\n")).toBe(true);
    expect(limited).toContain(small);
    const out = limited.slice(limited.indexOf("@large("));
    expect(out).not.toContain("@sc_rc_release_dyn(");
    expect(out.split("call void @scr_dyn_release(ptr %v)").length - 1).toBe(
      INLINE_DYN_RELEASES_PER_FUNCTION + 1,
    );
  });

  test("each family's budget applies to its own sites in a function that has both", () => {
    const strings = body("mixed", INLINE_STR_RELEASES_PER_FUNCTION + 1, "str");
    // One function: string sites over their budget, dyn sites within theirs.
    const mixed = strings.replace(
      "  ret void",
      `  call void @sc_rc_release_dyn(ptr %v)\n  call void @sc_rc_release_other(ptr %v)\n  ret void`,
    );
    const other = body("other", 2, "str");
    const limited = limitInlineReleases([mixed, other], "release").join("\n");
    const out = limited.slice(0, limited.indexOf("@other("));
    expect(out).not.toContain("@sc_rc_release_str(");
    expect(out).toContain("call void @sc_rc_release_dyn(ptr %v)");
    expect(out).toContain("call void @sc_rc_release_other(ptr %v)");
    expect(limited).toContain(other);
  });

  test("a function over the string budget calls the runtime string release at every site", () => {
    const small = body("small", INLINE_STR_RELEASES_PER_FUNCTION, "str");
    const large = body("large", INLINE_STR_RELEASES_PER_FUNCTION + 1, "str");
    const limited = limitInlineReleases([small, large], "release").join("\n");
    expect(limited).toContain(small);
    // Speed emission keeps every inline string release.
    expect(limitInlineReleases([small, large], "speed").join("\n")).toBe([small, large].join("\n"));
    const out = limited.slice(limited.indexOf("@large("));
    expect(out).not.toContain("@sc_rc_release_str(");
    expect(out.split("call void @scr_str_release(ptr %v)").length - 1).toBe(
      INLINE_STR_RELEASES_PER_FUNCTION + 1,
    );
  });
});

describe("emitted object releases", () => {
  test("a surviving headered record enqueues only when not already buffered", () => {
    const mod: IrModule = {
      irVersion: 17,
      sourceFile: "cycle.ts",
      entry: "main",
      functions: [],
      records: [{ id: "r0", fields: [{ name: "self", type: { kind: "record", shapeId: "r0" } }] }],
    };
    const { host } = declarationHost();
    host.tracedShapes.add("record:r0");
    const defs = emitRecordShapes({ ...host, objectAudit: false }, mod).defs.join("\n");
    const start = defs.indexOf("root:");
    const root = defs.slice(start, defs.indexOf("done:", start));
    expect(root).not.toContain("store i32");
    expect(root).toContain("getelementptr i8, ptr %o, i64 -4");
    expect(root).toContain("br i1 %queued, label %done, label %enqueue");
    expect(root.indexOf("enqueue:")).toBeLessThan(
      root.indexOf("call void @scr_cyc_on_release(ptr %o)"),
    );
  });

  test("freezable records count their references without the frozen bit", () => {
    const mod: IrModule = {
      irVersion: 17,
      sourceFile: "frozen.ts",
      entry: "main",
      functions: [],
      records: [
        { id: "plain", fields: [{ name: "n", type: F64 }] },
        { id: "frozen", fields: [{ name: "n", type: F64 }], freezable: true },
      ],
    };
    const body = (defs: string, name: string): string =>
      new RegExp(`^define internal void @${name}\\([^]*?^}`, "m").exec(defs)?.[0] ?? "";
    for (const [pointerBits, notFrozen, sharedBelow] of [
      [64, "-4611686018427387905", "-4611686018427387907"],
      [32, "-1073741825", "-1073741827"],
    ] as const) {
      const { host } = declarationHost(pointerBits);
      const defs = emitRecordShapes({ ...host, objectAudit: false }, mod).defs.join("\n");
      const S = pointerBits === 64 ? "i64" : "i32";
      const plain = body(defs, mangleRecordRelease("plain"));
      expect(plain).toContain(`%shared = icmp ult ${S} %rcm2, -3`);
      expect(plain).not.toContain("%refs");
      // The immortal word's count is ~FROZEN, which the compare sends to the
      // immortal test, like counts 0 and 1.
      const fast = body(defs, mangleRecordRelease("frozen"));
      expect(fast).toContain(`%refs = and ${S} %rc, ${notFrozen}`);
      expect(fast).toContain(`%rcm2 = sub ${S} %refs, 2`);
      expect(fast).toContain(`%shared = icmp ult ${S} %rcm2, ${sharedBelow}`);
      expect(fast).toContain(`%imm = icmp eq ${S} %rc, -1`);
      const slow = body(defs, `${mangleRecordRelease("frozen")}_slow`);
      expect(slow).toContain(`%refs = and ${S} %n, ${notFrozen}`);
      expect(slow).toContain(`%dead = icmp eq ${S} %refs, 0`);
    }
  });
});

describe("live-object audit notes", () => {
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: "audit.ts",
    entry: "main",
    functions: [],
    records: [{ id: "r0", fields: [{ name: "x", type: F64 }] }],
  };
  const emit = (objectAudit?: boolean) => {
    const { host, declarations } = declarationHost();
    const defs = emitRecordShapes(
      objectAudit === undefined ? host : { ...host, objectAudit },
      mod,
    ).defs.join("\n");
    return { defs, declarations };
  };

  test("direct emission keeps the SCR_RC_AUDIT notes by default", () => {
    const { defs, declarations } = emit();
    expect(defs).toContain("call void @scr_obj_alloc_note()");
    expect(defs).toContain("call void @scr_obj_free_note()");
    expect(declarations).toContain("declare void @scr_obj_alloc_note()");
  });

  test("plain builds omit the calls and their declarations", () => {
    const { defs, declarations } = emit(false);
    expect(defs).not.toContain("_note()");
    expect(declarations.filter((decl) => decl.includes("_note()"))).toEqual([]);
  });
});
