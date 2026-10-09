import { describe, expect, test } from "vitest";
import { type AllocHost, emitObjectAlloc, emitObjectFree, inlineAllocSupported } from "./alloc.js";

function host(inlineAlloc: boolean): AllocHost & { decls: Set<string>; oom: boolean } {
  const h = {
    decls: new Set<string>(),
    oom: false,
    sizeType: "i64" as const,
    inlineAlloc,
    declare(decl: string) {
      h.decls.add(decl);
    },
    needOom() {
      h.oom = true;
    },
  };
  return h;
}

/** Every SSA value and label is defined once (the lines are spliced into
 * one function body). */
function expectSingleDefinitions(lines: string[]): void {
  const defs = lines.flatMap((l) => {
    const value = /^\s*(%[\w.]+) = /.exec(l);
    const label = /^([\w.]+):/.exec(l);
    return value ? [value[1]!] : label ? [`%${label[1]!}`] : [];
  });
  expect(new Set(defs).size).toBe(defs.length);
}

describe("emitted object allocation", () => {
  test("inlines only where the runtime allocator state is a 64-bit process global", () => {
    expect(inlineAllocSupported({ pointerBits: 64, targetTriple: "" })).toBe(true);
    expect(inlineAllocSupported({ targetTriple: "x86_64-unknown-linux-gnu" })).toBe(true);
    expect(inlineAllocSupported({ targetTriple: "arm64-apple-macosx14.0.0" })).toBe(true);
    expect(inlineAllocSupported({ pointerBits: 32 })).toBe(false);
    expect(inlineAllocSupported({ wasi: true })).toBe(false);
    expect(inlineAllocSupported({ targetTriple: "wasm32-unknown-wasip1" })).toBe(false);
    expect(inlineAllocSupported({ targetTriple: "x86_64-pc-windows-msvc" })).toBe(false);
    expect(inlineAllocSupported({ targetTriple: "x86_64-w64-windows-gnu" })).toBe(false);
    expect(inlineAllocSupported({ threadInstances: true })).toBe(false);
  });

  test("keeps the out-of-line calls when inlining is off", () => {
    const h = host(false);
    expect(emitObjectAlloc(h, "24", null)).toEqual([
      "  %o = call ptr @scr_rt_calloc(i64 24)",
      "  %isnull = icmp eq ptr %o, null",
      "  br i1 %isnull, label %oom, label %ok",
      "oom:",
      "  call void @sc_oom()",
      "  unreachable",
      "ok:",
      "  call void @scr_obj_alloc_note()",
    ]);
    expect(emitObjectAlloc(h, "24", { trace: "@t", free: "@f" })).toEqual([
      "  %o = call ptr @scr_cyc_alloc(i64 24, ptr @t, ptr @f)",
      "  call void @scr_obj_alloc_note()",
    ]);
    expect(emitObjectFree(h, true)).toEqual([
      "  call void @scr_obj_free_note()",
      "  call void @scr_cyc_free(ptr %o)",
    ]);
    expect(emitObjectFree(h, false)).toEqual([
      "  call void @scr_obj_free_note()",
      "  call void @scr_weak_dispose(ptr %o)",
      "  call void @scr_rt_free(ptr %o)",
    ]);
    expect([...h.decls].some((d) => d.includes("@scr_sa"))).toBe(false);
  });

  test("inline allocation falls back to the audited out-of-line entry points", () => {
    const h = host(true);
    const plain = emitObjectAlloc(h, "40", null, 16);
    expectSingleDefinitions(plain);
    expect(h.oom).toBe(true);
    // Recycled blocks clear everything past the bytes the caller stores.
    expect(plain).toContain("  %sa.z = getelementptr inbounds i8, ptr %sa.b, i64 16");
    // The slow path is the old sequence: allocate, OOM check, audit note.
    const slow = plain.slice(plain.indexOf("sa.slow:"));
    expect(slow).toContain("  %sa.s = call ptr @scr_rt_calloc(i64 40)");
    expect(slow).toContain("  call void @scr_obj_alloc_note()");
    expect(plain.filter((l) => l.includes("@scr_obj_alloc_note")).length).toBe(1);
    expect(plain.at(-1)).toBe("  %o = phi ptr [ %sa.blk, %sa.fast ], [ %sa.s, %sa.noted ]");

    const cyc = emitObjectAlloc(h, "40", { trace: "@t", free: "@f" });
    expectSingleDefinitions(cyc);
    expect(cyc).toContain("  %sa.n = add i64 40, 32");
    expect(cyc).toContain("  %sa.s = call ptr @scr_cyc_alloc(i64 40, ptr @t, ptr @f)");
    expect(cyc).toContain("  store i64 %sa.live1, ptr @scr_cyc_live");
    expect(h.decls).toContain(
      "@scr_sa = external global { i64, i64, i32, [32 x ptr], [32 x ptr], [32 x ptr] }",
    );
  });

  test("inline frees route foreign blocks and the bypassed allocator to scr_rt_free", () => {
    for (const cyc of [false, true]) {
      const h = host(true);
      const lines = emitObjectFree(h, cyc);
      expectSingleDefinitions(lines);
      const blk = cyc ? "%sf.blk" : "%o";
      const sys = lines.slice(lines.indexOf(lines.find((l) => l.startsWith("sf.sys:"))!));
      expect(sys).toContain("  call void @scr_obj_free_note()");
      expect(sys).toContain(`  call void @scr_rt_free(ptr ${blk})`);
      expect(lines).toContain("  call void %sf.hook(ptr %o)");
      expect(lines.some((l) => l.includes("@scr_cyc_live"))).toBe(cyc);
      expect(lines.at(-1)).toBe("sf.done:");
    }
  });
});
