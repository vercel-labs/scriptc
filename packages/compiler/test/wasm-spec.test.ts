/* The WebAssembly decoder (src/wasm/binary.ts) against the specification's
 * test suite, against V8 on mutations of those modules, and on the inline
 * modules of real packages in this workspace. V8 (the Node running the
 * test) is the oracle: scriptc must accept exactly the modules Node
 * accepts, within the translatable feature level. */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm } from "../src/wasm/binary.js";
import { decodeBase64 } from "../src/wasm/discover.js";

/** V8's verdict (the compiler's type world declares no WebAssembly value). */
const v8Validate = (bytes: Uint8Array): boolean =>
  (
    globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }
  ).WebAssembly.validate(bytes);

interface SpecCase {
  suite: string;
  v8: string;
  where: string;
  bytes: Uint8Array;
}

const cases: SpecCase[] = readFileSync(join(import.meta.dirname, "wasm-spec-cases.txt"), "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const [suite, v8, where, b64] = line.split(" ");
    return {
      suite: suite!,
      v8: v8!,
      where: where!,
      bytes: new Uint8Array(Buffer.from(b64!, "base64")),
    };
  });

const accepted = (status: string): boolean => status === "valid" || status === "unsupported";

describe("WebAssembly spec test suite", () => {
  test("covers the 2.0 core suite and extended constant expressions", () => {
    expect(cases.length).toBeGreaterThan(3000);
    const extended = cases.filter((c) => c.where.startsWith("extended-const/"));
    expect(extended.length).toBeGreaterThan(10);
    expect(
      extended.filter((c) => analyzeWasm(c.bytes).features.includes("extended-const")).length,
    ).toBeGreaterThan(5);
  });

  test("every module gets V8's verdict and needs no other proposal", () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const s = analyzeWasm(c.bytes);
      const v8 = v8Validate(c.bytes);
      if ((v8 ? "valid" : "invalid") !== c.v8) wrong.push(`${c.where}: V8 changed its verdict`);
      // Multiple memories are the one proposal outside the translatable set
      // that 2.0 tests exercise (as invalid; V8 accepts them).
      const allowed = s.status !== "unsupported" || s.unsupported.join() === "multi-memory";
      if (accepted(s.status) !== v8 || !allowed) {
        wrong.push(`${c.where}: ${s.status} ${s.error ?? ""} (V8 ${v8 ? "accepts" : "rejects"})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("differs from the 2.0 suite only where WebAssembly 3.0 and V8 relaxed it", () => {
    // Multiple memories became valid, and memory.size/grow's reserved byte
    // a memory index, so a long LEB128 zero is accepted (multi-memory);
    // global initializers and segment offsets may read defined immutable
    // globals (GC proposal).
    const relaxed = cases.filter((c) => c.suite !== "valid" && c.v8 === "valid");
    expect(relaxed.length).toBeGreaterThan(0);
    for (const c of relaxed) {
      expect(c.where).toMatch(
        /^(?:extended-const\/)?(?:binary|data|elem|global|imports|memory)\.wast:\d+$/,
      );
    }
    expect(relaxed.length).toBeLessThan(30);
  });
});

describe("mutations of the suite's valid modules", () => {
  test("never disagree with V8 (deterministic sample)", () => {
    const seeds = cases.filter((c) => c.v8 === "valid").map((c) => c.bytes);
    let state = 0x9e3779b9;
    const random = (n: number): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % n;
    };
    const disagreements: string[] = [];
    for (let i = 0; i < 8000; i++) {
      const seed = seeds[random(seeds.length)]!;
      const at = 8 + random(Math.max(1, seed.length - 8));
      let bytes: Uint8Array;
      switch (random(4)) {
        case 0:
          bytes = Uint8Array.from(seed);
          bytes[at] = bytes[at]! ^ (1 << random(8));
          break;
        case 1:
          bytes = Uint8Array.from(seed);
          bytes[at] = random(256);
          break;
        case 2:
          bytes = new Uint8Array([...seed.subarray(0, at), ...seed.subarray(at + 1)]);
          break;
        default:
          bytes = new Uint8Array([...seed.subarray(0, at), random(256), ...seed.subarray(at)]);
      }
      const s = analyzeWasm(bytes);
      if (s.status === "unsupported") continue;
      if (accepted(s.status) !== v8Validate(bytes)) {
        disagreements.push(
          `${s.status} ${s.error ?? ""}: ${Buffer.from(bytes).toString("base64")}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe("modules inlined by packages in this workspace", () => {
  // Lockfile-pinned installs: undici's llhttp (with and without SIMD) and
  // es-module-lexer, both inlined as base64 string literals.
  const root = join(import.meta.dirname, "../../..");
  const inline = (pattern: string): Uint8Array[] =>
    globSync(join(root, pattern))
      .sort()
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/AGFzbQ[A-Za-z0-9+/=]*/g)].map((m) =>
          decodeBase64(m[0])!,
        ),
      );

  test("undici's llhttp: the scalar module translates, the SIMD one needs SIMD", () => {
    const scalar = inline(
      "node_modules/.pnpm/undici@7.*/node_modules/undici/lib/llhttp/llhttp-wasm.js",
    );
    const simd = inline(
      "node_modules/.pnpm/undici@7.*/node_modules/undici/lib/llhttp/llhttp_simd-wasm.js",
    );
    expect(scalar.length).toBeGreaterThan(0);
    expect(simd.length).toBeGreaterThan(0);
    for (const bytes of scalar) {
      expect(analyzeWasm(bytes)).toMatchObject({ status: "valid", importModules: ["env"] });
      expect(v8Validate(bytes)).toBe(true);
    }
    for (const bytes of simd) {
      expect(analyzeWasm(bytes)).toMatchObject({ status: "unsupported", unsupported: ["simd"] });
      expect(v8Validate(bytes)).toBe(true);
    }
  });

  test("es-module-lexer's module is plain MVP", () => {
    const modules = inline(
      "node_modules/.pnpm/es-module-lexer@1.*/node_modules/es-module-lexer/dist/lexer.js",
    );
    expect(modules.length).toBeGreaterThan(0);
    for (const bytes of modules) {
      expect(analyzeWasm(bytes)).toMatchObject({ status: "valid", imports: 0 });
      expect(v8Validate(bytes)).toBe(true);
    }
  });
});
