import { describe, expect, test } from "vitest";
import {
  type AllocHost,
  disposeHookLoadLines,
  emitObjectAlloc,
  emitObjectFree,
  inlineAllocSupported,
} from "./alloc.js";

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
    expect(emitObjectAlloc(h, "24", { type: "@ty" })).toEqual([
      "  %o = call ptr @scr_cyc_alloc(i64 24, ptr @ty)",
      "  call void @scr_obj_alloc_note()",
    ]);
    expect(emitObjectFree(h, true)).toEqual([
      "  call void @scr_obj_free_note()",
      "  call void @scr_cyc_free(ptr %o)",
    ]);
    expect(emitObjectFree(h, false)).toEqual([
      "  call void @scr_obj_free_note()",
      "  %sf.obs = load i1, ptr @sc_weak_keys",
      "  br i1 %sf.obs, label %sf.observe, label %sf.block",
      "sf.observe:",
      "  call void @scr_weak_dispose(ptr %o)",
      "  br label %sf.block",
      "sf.block:",
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

    const cyc = emitObjectAlloc(h, "40", { type: "@ty" });
    expectSingleDefinitions(cyc);
    expect(cyc).toContain("  %sa.n = add i64 40, 8");
    // The 8-byte header: the descriptor's i16 registry id, then zero color,
    // generation and buffer state; an unregistered descriptor (id 0) takes
    // the slow path.
    expect(cyc).toContain(
      "  %sa.tidp = getelementptr inbounds { ptr, ptr, i32, i32 }, ptr @ty, i32 0, i32 3",
    );
    expect(cyc).toContain("  %sa.tid = load atomic i32, ptr %sa.tidp acquire, align 4");
    expect(cyc).toContain("  %sa.small = and i1 %sa.reg, %sa.fits0");
    expect(cyc).toContain("  store i16 %sa.id, ptr %sa.blk ; ScrCycHdr.id");
    expect(cyc).toContain("  store i32 0, ptr %sa.bufp ; ScrCycHdr.buf");
    expect(cyc).toContain("  %sa.s = call ptr @scr_cyc_alloc(i64 40, ptr @ty)");
    expect(cyc).toContain("  store i64 %sa.live1, ptr @scr_cyc_live");
    expect(h.decls).toContain(
      "@scr_sa = external global { i64, i64, i32, [40 x ptr], [40 x ptr], [40 x ptr] }",
    );
  });

  test("inline size classes match the runtime's: 8-byte steps to 128, then 16", () => {
    const lines = emitObjectAlloc(host(true), "%n", null);
    // Evaluate the integer arithmetic of the class and block-size lines.
    const env = new Map<string, bigint>();
    const val = (v: string) => (v.startsWith("%") ? env.get(v)! : BigInt(v));
    const run = (n: number) => {
      env.clear();
      env.set("%n", BigInt(n));
      for (const line of lines) {
        const m = /^\s*(%[\w.]+) = (add|sub|lshr|shl) i64 ([%\w.]+), ([%\w.]+)$/.exec(line);
        const cmp = /^\s*(%[\w.]+) = icmp (ule|eq) i64 ([%\w.]+), ([%\w.]+)$/.exec(line);
        const ext = /^\s*(%[\w.]+) = zext i1 (%[\w.]+) to i64$/.exec(line);
        const sel = /^\s*(%[\w.]+) = select i1 (%[\w.]+), i64 ([%\w.]+), i64 ([%\w.]+)$/.exec(line);
        if (m) {
          const [a, b] = [val(m[3]!), val(m[4]!)];
          const ops = { add: a + b, sub: a - b, lshr: a >> b, shl: a << b };
          env.set(m[1]!, ops[m[2] as keyof typeof ops]);
        } else if (cmp) {
          const [a, b] = [val(cmp[3]!), val(cmp[4]!)];
          env.set(cmp[1]!, (cmp[2] === "eq" ? a === b : a <= b) ? 1n : 0n);
        } else if (ext) {
          env.set(ext[1]!, val(ext[2]!));
        } else if (sel) {
          env.set(sel[1]!, val(sel[2]!) === 1n ? val(sel[3]!) : val(sel[4]!));
        }
      }
      return { c: Number(env.get("%sa.c")), size: Number(env.get("%sa.sz")) };
    };
    let prev = 0;
    for (let n = 1; n <= 512; n++) {
      const { c, size } = run(n);
      const step = n <= 128 ? 8 : 16;
      expect(size).toBe(n > 48 && n <= 56 ? 64 : Math.ceil(n / step) * step);
      expect(c === prev || c === prev + 1).toBe(true);
      prev = c;
    }
    expect(run(8)).toEqual({ c: 0, size: 8 });
    expect(run(48)).toEqual({ c: 5, size: 48 });
    expect(run(56)).toEqual({ c: 6, size: 64 });
    expect(run(57)).toEqual({ c: 7, size: 64 });
    expect(run(129)).toEqual({ c: 16, size: 144 });
    expect(run(512)).toEqual({ c: 39, size: 512 });
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
      if (cyc) {
        // The generation is the i8 at obj-5.
        expect(lines).toContain("  %sf.blk = getelementptr inbounds i8, ptr %o, i64 -8");
        expect(lines).toContain("  %sf.genp = getelementptr inbounds i8, ptr %sf.blk, i64 3");
        expect(lines).toContain("  %sf.old = icmp eq i8 %sf.gen, 2");
      }
      expect(lines.at(-1)).toBe("sf.done:");
    }
  });

  test("frees test the dispose hook only where the program can observe them", () => {
    const h = host(true);
    const weak = emitObjectFree(h, false);
    expectSingleDefinitions(weak);
    expect(weak.slice(0, 2)).toEqual([
      "  %sf.obs = load i1, ptr @sc_weak_keys",
      "  br i1 %sf.obs, label %sf.hooked, label %sf.block",
    ]);
    const records = emitObjectFree(h, true, "weak-or-source");
    expectSingleDefinitions(records);
    expect(records.slice(0, 4)).toEqual([
      "  %sf.obsw = load i1, ptr @sc_weak_keys",
      "  %sf.obss = load i1, ptr @sc_record_sources",
      "  %sf.obs = or i1 %sf.obsw, %sf.obss",
      "  br i1 %sf.obs, label %sf.hooked, label %sf.block",
    ]);
    expect(records).toContain("  call void %sf.hook(ptr %o)");
  });

  test("loads the dispose hook from emitted code only with the inline allocator", () => {
    expect(disposeHookLoadLines(host(false), "%t1")).toBeNull();
    expect(disposeHookLoadLines(host(true), "%t1")).toEqual([
      "  %t1 = load ptr, ptr @scr_weak_dispose_hook",
    ]);
  });
});
