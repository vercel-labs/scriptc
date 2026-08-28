/* The surface manifest is a shipped artifact with two contract properties:
 * the version spine is the exact published release version, and every
 * non-static entry carries the diagnostic code the compiler actually
 * raises for it. This suite holds the manifest to both:
 *
 * - staleness guard: the committed packages/compiler/surface-manifest.json
 *   regenerates byte-identically from the current tree (a table edit that
 *   changes the projection fails here until `pnpm manifest` is rerun and
 *   the result committed);
 * - schema and determinism: unique sorted ids, valid kind/status values,
 *   a code on every non-static entry, identical output across generations;
 * - the sampling harness: N probe programs per status class, checked
 *   against the compiler itself — listed-static entries COMPILE, and for
 *   every sampled non-static entry the refusal's diagnostic code equals
 *   the entry's code (dynamic-only entries additionally analyze clean
 *   under --dynamic). The probes don't exercise every entry; they exist
 *   to catch the manifest lying.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyze,
  compile,
  generateSurfaceManifest,
  ir,
  LIB_FN_SIGS,
  renderDiagnostics,
  renderSurfaceManifest,
  resolveLibraryFences,
  type SurfaceManifest,
} from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const manifestPath = join(repoRoot, "packages/compiler/surface-manifest.json");
const readJson = (p: string): { version: string } =>
  JSON.parse(readFileSync(join(repoRoot, p), "utf8")) as { version: string };

// The version spine: the release workflow keys on packages/cli (the
// published `scriptc` package); sync-versions.mjs stamps the same string
// into runtime, the native LLVM helper, and compiler.
const releaseVersion = readJson("packages/cli/package.json").version;

const committed = readFileSync(manifestPath, "utf8");
const manifest = generateSurfaceManifest(releaseVersion);
const entryById = new Map(manifest.entries.map((e) => [e.id, e]));

describe("surface manifest generation", () => {
  test("the committed manifest regenerates byte-identically (staleness guard)", () => {
    expect(
      renderSurfaceManifest(manifest),
      "packages/compiler/surface-manifest.json is stale — run 'pnpm manifest' and commit the result",
    ).toBe(committed);
  });

  test("generation is deterministic", () => {
    expect(renderSurfaceManifest(generateSurfaceManifest(releaseVersion))).toBe(
      renderSurfaceManifest(manifest),
    );
  });

  test("the version spine is the exact published version string", () => {
    const parsed = JSON.parse(committed) as SurfaceManifest;
    expect(parsed.compilerVersion).toBe(releaseVersion);
    // The four packages publish in lockstep; a drifted stamp would make
    // the spine ambiguous for a version pin.
    expect(readJson("packages/compiler/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-darwin-arm64/package.json").version).toBe(releaseVersion);
  });

  test("schema: ids unique and sorted, enums valid, codes on every non-static entry", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);
    const ids = manifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const e of manifest.entries) {
      expect(e.id).toMatch(/^[a-z][a-z0-9-]*(\.[A-Za-z0-9$_-]+)+$/);
      expect(["syntax", "stdlib", "node-builtin", "diagnostic-fence"]).toContain(e.kind);
      expect(["static", "dynamic-only", "unsupported"]).toContain(e.status);
      if (e.status !== "static") {
        expect(e.code, `${e.id}: non-static entries must carry their diagnostic code`).toMatch(
          /^SC\d{4}$/,
        );
      }
    }
    // Every kind and every status class is populated — an empty class
    // means a projection source silently dropped out.
    for (const kind of ["syntax", "stdlib", "node-builtin", "diagnostic-fence"]) {
      expect(manifest.entries.some((e) => e.kind === kind), `no ${kind} entries`).toBe(true);
    }
    for (const status of ["static", "dynamic-only", "unsupported"]) {
      expect(manifest.entries.some((e) => e.status === status), `no ${status} entries`).toBe(true);
    }
  });
});

/* ── the sampling harness ────────────────────────────────────────────────
 * Each probe is one program exercising exactly one manifest entry. The
 * EXPECTATION is not written here — it is read from the manifest, so a
 * probe checks what the manifest CLAIMS: a status flip, a code change, or
 * an id rename in the manifest fails the probe until both agree again. */
interface Probe {
  id: string;
  source: string;
}

const PROBES: Probe[] = [
  // status static — these must compile to a binary
  { id: "syntax.compound-assignment.plus", source: 'let x = 1;\nx += 2;\nconsole.log(x);\n' },
  { id: "stdlib.string.charCodeAt", source: 'console.log("abc".charCodeAt(0));\n' },
  { id: "stdlib.array.push", source: "const xs: number[] = [1];\nxs.push(2);\nconsole.log(xs.length);\n" },
  { id: "stdlib.array.unshift", source: "const xs: number[] = [2];\nconsole.log(xs.unshift(1), xs[0]);\n" },
  { id: "stdlib.array.reverse", source: "const xs: number[] = [1, 2];\nconsole.log(xs.reverse()[0]);\n" },
  { id: "stdlib.math.floor", source: "console.log(Math.floor(1.5));\n" },
  { id: "stdlib.math.E", source: "console.log(Math.E);\n" },
  { id: "stdlib.math.PI", source: "console.log(Math.PI);\n" },
  { id: "stdlib.map.has", source: 'const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log(m.has("a"));\n' },
  { id: "stdlib.date.now", source: "console.log(Date.now() > 0);\n" },
  { id: "stdlib.number.toFixed", source: "const n = 1.2345;\nconsole.log(n.toFixed(2));\n" },
  { id: "stdlib.abort-signal.timeout", source: "const signal = AbortSignal.timeout(1000);\nconsole.log(signal.aborted);\n" },
  {
    id: "stdlib.abort-controller.constructor",
    source: "const controller = new AbortController();\ncontroller.abort();\nconsole.log(controller.signal.aborted);\n",
  },
  {
    id: "stdlib.readable-stream.constructor",
    source: "const stream = new ReadableStream<number>();\nconsole.log(stream.locked);\n",
  },
  {
    id: "stdlib.readable-stream.from",
    source: "const stream = ReadableStream.from([1, 2]);\nconsole.log(stream.locked);\n",
  },
  {
    id: "stdlib.response.constructor",
    source: '/// <reference types="node" />\nvoid new Response("ok");\n',
  },
  { id: "node-builtin.process.pid", source: "console.log(process.pid > 0);\n" },
  { id: "node-builtin.perf_hooks.performance.now", source: "console.log(performance.now() >= 0);\n" },
  { id: "node-builtin.path.join", source: 'import { join } from "node:path";\nconsole.log(join("a", "b"));\n' },
  { id: "node-builtin.os.EOL", source: 'import { EOL } from "node:os";\nconsole.log(EOL.length);\n' },
  // status dynamic-only — refused with the entry's code statically,
  // analyzed clean under --dynamic
  { id: "stdlib.math.sqrt", source: "console.log(Math.sqrt(2));\n" },
  { id: "stdlib.string.replace", source: 'console.log("aa".replace("a", "b"));\n' },
  {
    id: "stdlib.headers.entries",
    source: '/// <reference types="node" />\nasync function f(): Promise<void> {\n  const r = await fetch("http://127.0.0.1");\n  void r.headers.entries();\n}\nvoid f();\n',
  },
  {
    id: "stdlib.request.constructor",
    source: '/// <reference types="node" />\nvoid new Request("http://127.0.0.1");\n',
  },
  {
    id: "stdlib.headers.symbol.iterator",
    source: '/// <reference types="node" />\nfunction f([first]: Headers): void {\n  void first;\n}\nvoid f;\n',
  },
  { id: "diagnostic.sc2011", source: "const y: any = 1;\nconst z = y * 2;\nconsole.log(0);\n" },
  // status unsupported — refused with the entry's code
  {
    id: "stdlib.abort-signal.constructor",
    source: '/// <reference types="node" />\nvoid new AbortSignal();\n',
  },
  {
    id: "stdlib.headers.constructor",
    source: '/// <reference types="node" />\nvoid new Headers();\n',
  },
  {
    id: "stdlib.response.static.json",
    source: '/// <reference types="node" />\nvoid Response.json(1);\n',
  },
  {
    id: "stdlib.response.clone",
    source: '/// <reference types="node" />\nasync function f(): Promise<void> {\n  const r = await fetch("http://127.0.0.1");\n  void r.clone();\n}\nvoid f();\n',
  },
  {
    id: "stdlib.readable-stream.tee",
    source: '/// <reference types="node" />\ntype BodyStream = ReadableStream<Uint8Array>;\nfunction f(s: BodyStream): void {\n  void s.tee();\n}\nconsole.log(typeof f);\n',
  },
  {
    id: "stdlib.fetch.request-init.cache",
    source: '/// <reference types="node" />\nconst init: RequestInit = { cache: "no-store" };\nvoid fetch("http://127.0.0.1", init);\nvoid fetch("http://127.0.0.1", { ...({ cache: "no-store" } as const) });\n',
  },
  {
    id: "stdlib.fetch.request-init.dispatcher",
    source: '/// <reference types="node" />\nvoid fetch("http://127.0.0.1", { dispatcher: JSON.parse("{}") });\n',
  },
  {
    id: "stdlib.readable-stream.symbol.asyncIterator",
    source: '/// <reference types="node" />\nfunction f(s: ReadableStream<Uint8Array>): void {\n  void s[Symbol.asyncIterator]();\n}\nvoid f;\n',
  },
  { id: "syntax.debugger-statements", source: "debugger;\nconsole.log(0);\n" },
  {
    id: "syntax.delete-expressions",
    source:
      'type Hybrid = { base: string; [k: string]: string };\nconst h: Hybrid = { base: "b", extra: "e" };\ndelete h["extra"];\nconsole.log(h.base);\n',
  },
  // Class-instance field/getter destructures graduated (corpus 2429); the
  // METHOD-extraction refusal carries the sample now.
  { id: "diagnostic.sc1031", source: "class C {\n  f = 1;\n  m(): number {\n    return this.f;\n  }\n}\nconst { m } = new C();\nconsole.log(m());\n" },
  { id: "diagnostic.sc1121", source: 'console.log(/ab/g.test("abab"));\n' },
  {
    id: "node-builtin.zlib.gzipSync",
    source: 'import { gzipSync } from "node:zlib";\ngzipSync("data");\nconsole.log(0);\n',
  },
];

// Keep probes below the workspace so explicit `/// <reference types="node" />`
// rows resolve the repository's pinned @types/node package. Ordinary probes
// still use the compiler fallback declarations exactly as before.
const probeCacheRoot = join(repoRoot, "node_modules/.cache");
mkdirSync(probeCacheRoot, { recursive: true });
const probeRoot = mkdtempSync(join(probeCacheRoot, "scr-surface-manifest-"));
writeFileSync(
  join(probeRoot, "tsconfig.json"),
  `${JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } }, null, 2)}\n`,
);

function probeFile(probe: Probe): string {
  const dir = join(probeRoot, probe.id.replace(/[^A-Za-z0-9]+/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.ts");
  writeFileSync(file, probe.source);
  return file;
}

describe("surface manifest sampling harness", () => {
  test("the probe set covers every status class", () => {
    const byStatus = new Map<string, number>();
    for (const p of PROBES) {
      const entry = entryById.get(p.id);
      expect(entry, `probe id ${p.id} is not in the manifest`).toBeDefined();
      byStatus.set(entry!.status, (byStatus.get(entry!.status) ?? 0) + 1);
    }
    expect(byStatus.get("static") ?? 0).toBeGreaterThanOrEqual(5);
    expect(byStatus.get("dynamic-only") ?? 0).toBeGreaterThanOrEqual(4);
    expect(byStatus.get("unsupported") ?? 0).toBeGreaterThanOrEqual(4);
  });

  test.for(PROBES.map((p) => [p.id, p] as const))("%s", async ([, probe]) => {
    const entry = entryById.get(probe.id);
    expect(entry, `probe id ${probe.id} is not in the manifest`).toBeDefined();
    const file = probeFile(probe);
    if (entry!.status === "static") {
      const outDir = join(file, "..", "out");
      const result = await compile(file, { outPath: join(outDir, "bin"), outDir });
      if (!result.ok) {
        expect.unreachable(
          `${probe.id} is listed static but did not compile:\n` +
            renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false }),
        );
      }
      const dyn = analyze(file, { dynamic: true }).coverage;
      expect(
        dyn.diagnostics.map((d) => `${d.code}: ${d.message}`),
        `${probe.id}: enabling --dynamic must not disable a static surface`,
      ).toEqual([]);
      expect(dyn.stats.statementsFailed).toBe(0);
      return;
    }
    // Non-static: the refusal's code must equal the entry's code — the
    // property external tooling depends on most.
    const { coverage } = analyze(file);
    expect(coverage.preflightFailed, `${probe.id}: probe must reach lowering`).toBe(false);
    const codes = [...new Set(coverage.diagnostics.map((d) => d.code))];
    expect(codes, `${probe.id}: expected exactly the listed refusal code`).toEqual([entry!.code]);
    if (entry!.status === "dynamic-only") {
      const dyn = analyze(file, { dynamic: true }).coverage;
      expect(
        dyn.diagnostics.map((d) => `${d.code}: ${d.message}`),
        `${probe.id}: dynamic-only entries must analyze clean under --dynamic`,
      ).toEqual([]);
      expect(dyn.stats.statementsFailed).toBe(0);
    } else {
      const dyn = analyze(file, { dynamic: true }).coverage;
      expect(dyn.preflightFailed, `${probe.id}: dynamic probe must reach lowering`).toBe(false);
      const dynCodes = [...new Set(dyn.diagnostics.map((d) => d.code))];
      expect(
        dynCodes,
        `${probe.id}: unsupported entries must retain the listed refusal under --dynamic`,
      ).toEqual([entry!.code]);
    }
  });
});

test("unsupported RequestInit keys remain fenced when const-computed", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.cache.computed",
    source:
      '/// <reference types="node" />\nconst option = "cache" as const;\nvoid fetch("http://127.0.0.1", { [option]: "no-store" });\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  for (const dynamic of [false, true]) {
    const { coverage } = analyze(file, { dynamic });
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
    expect(coverage.diagnostics[0]!.message).toContain("RequestInit option 'cache'");
  }
});

test("unsupported RequestInit keys remain fenced through imported const aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "scr-request-init-import-"));
  const initFile = join(root, "init.ts");
  const mainFile = join(root, "main.ts");
  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } }, null, 2)}\n`,
  );
  writeFileSync(
    initFile,
    'export const init = { method: "GET", cache: "no-store" } as const;\n',
  );
  writeFileSync(
    mainFile,
    'import { init } from "./init.js";\nvoid fetch("http://127.0.0.1", init);\n',
  );
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  for (const dynamic of [false, true]) {
    const { coverage } = analyze(mainFile, { dynamic });
    expect(
      coverage.preflightFailed,
      coverage.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    ).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
    expect(coverage.diagnostics[0]!.message).toContain("RequestInit option 'cache'");
  }
});

test("RequestInit fences statically traceable property and conditional values", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.cache.traced-expressions",
    source:
      '/// <reference types="node" />\n' +
      'const options = { init: { cache: "no-store" } } as const;\n' +
      'void fetch("http://127.0.0.1", options.init);\n' +
      'const enabled = true;\n' +
      'const init: RequestInit = enabled ? { cache: "no-store" } : { method: "GET" };\n' +
      'void fetch("http://127.0.0.1", init);\n' +
      'const disabled = false;\n' +
      'const safe: RequestInit = disabled ? { cache: "no-store" } : { method: "GET" };\n' +
      'void fetch("http://127.0.0.1", safe);\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(coverage.diagnostics.filter((d) => d.code === entry!.code)).toHaveLength(2);
  const dynamic = analyze(file, { dynamic: true }).coverage;
  expect([...new Set(dynamic.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(dynamic.diagnostics.filter((d) => d.code === entry!.code)).toHaveLength(2);
});

test("RequestInit traces properties through annotated const wrappers", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.cache.annotated-wrapper",
    source:
      '/// <reference types="node" />\n' +
      'const options: { init: RequestInit } = { init: { cache: "no-store" } };\n' +
      'void fetch("http://127.0.0.1", options.init);\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(coverage.diagnostics).toHaveLength(1);
  expect(coverage.diagnostics[0]!.message).toContain(
    "RequestInit option 'cache' in a static build",
  );
  const dynamic = analyze(file, { dynamic: true }).coverage;
  expect([...new Set(dynamic.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(dynamic.diagnostics).toHaveLength(1);
});

test("RequestInit wrapper tracing respects a later property override", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.annotated-wrapper-override",
    source:
      '/// <reference types="node" />\n' +
      'const base: { init: RequestInit } = { init: { cache: "no-store" } };\n' +
      'const options: { init: RequestInit } = { ...base, init: { method: "GET" } };\n' +
      'void fetch("http://127.0.0.1", options.init);\n',
  });
  for (const dynamic of [false, true]) {
    const { coverage } = analyze(file, { dynamic });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("RequestInit spread tracing respects a later undefined override", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.spread-undefined-override",
    source:
      '/// <reference types="node" />\n' +
      'const unsupported = { cache: "no-store" } as const;\n' +
      'void fetch("http://127.0.0.1", { ...unsupported, cache: undefined });\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("RequestInit tracing stops at property-mutated const objects", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.mutated-const",
    source:
      '/// <reference types="node" />\n' +
      'const init: RequestInit = { cache: "no-store" };\n' +
      'init.cache = undefined;\n' +
      'void fetch("http://127.0.0.1", init);\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("RequestInit traces const object and tuple binding aliases", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.cache.destructured-alias",
    source:
      '/// <reference types="node" />\n' +
      'const options = { wrapper: { init: { cache: "no-store" } } } as const;\n' +
      'const { wrapper: { init } } = options;\n' +
      'void fetch("http://127.0.0.1", init);\n' +
      'const tuple = [{ cache: "no-store" }] as const;\n' +
      'const [tupleInit] = tuple;\n' +
      'void fetch("http://127.0.0.1", tupleInit);\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
    expect(coverage.diagnostics.filter((d) => d.code === entry!.code)).toHaveLength(2);
  }
});

test("island RequestInit literals accept supported const-computed keys", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.method.computed",
    source:
      '/// <reference types="node" />\n' +
      'const option = "method" as const;\n' +
      'void fetch("http://127.0.0.1", { [option]: "GET" });\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("finite unions of dynamic-only Headers members retain the static fence", () => {
  const file = probeFile({
    id: "stdlib.headers.dynamic-member-union",
    source:
      '/// <reference types="node" />\n' +
      'async function f(select: boolean): Promise<void> {\n' +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const member: "keys" | "values" = select ? "keys" : "values";\n' +
      '  void response.headers[member]();\n' +
      '}\n' +
      'void f;\n',
  });
  const entry = entryById.get("stdlib.headers.keys");
  expect(entry).toBeDefined();
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(coverage.diagnostics).toHaveLength(1);
  expect(coverage.diagnostics[0]!.message).toContain("Headers.keys in a static build");
  const dynamic = analyze(file, { dynamic: true }).coverage;
  expect(dynamic.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
});

test("fetch handle method calls retain their receiver through bracket spellings", () => {
  const file = probeFile({
    id: "stdlib.fetch.bracket-method-calls",
    source:
      '/// <reference types="node" />\n' +
      'async function f(): Promise<void> {\n' +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const header: string | null = response.headers["get"]("x-kind");\n' +
      '  const text: string = await response["text"]();\n' +
      '  const member: "get" | "has" = header === null ? "get" : "has";\n' +
      '  const selected: string | boolean | null = response.headers[member]("x-kind");\n' +
      '  void text; void selected;\n' +
      '}\n' +
      'void f;\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("static Response method unions retain their declared promise result", () => {
  const file = probeFile({
    id: "stdlib.response.computed-body-method-union",
    source:
      '/// <reference types="node" />\n' +
      'async function f(select: boolean): Promise<void> {\n' +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const member: "text" | "bytes" = select ? "text" : "bytes";\n' +
      '  const body: string | Uint8Array = await response[member]();\n' +
      '  void body;\n' +
      '}\n' +
      'void f;\n',
  });
  const coverage = analyze(file).coverage;
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("fetch companion surplus arguments remain supported under --dynamic", () => {
  const dir = join(probeRoot, "fetch-companion-surplus");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.js");
  writeFileSync(
    file,
    'const side = () => 1;\n' +
      'void AbortSignal.abort(undefined, side());\n' +
      'void AbortSignal.timeout(1, side());\n' +
      'void AbortSignal.any([], side());\n' +
      'void ReadableStream.from([], side());\n',
  );
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("fetch interface object bindings retain the inventory fence code", () => {
  const file = probeFile({
    id: "stdlib.fetch.object-binding-fences",
    source:
      '/// <reference types="node" />\n' +
      'function headers(value: Headers): void { const { entries } = value; }\n' +
      'function response(value: Response): void { const { clone } = value; }\n' +
      'function stream(value: ReadableStream<Uint8Array>): void { const { tee } = value; }\n' +
      'function assign(value: Headers, entries: unknown): void { ({ entries } = value); }\n' +
      'void headers; void response; void stream; void assign;\n',
  });
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  expect(coverage.diagnostics.filter((d) => d.code === "SC2020")).toHaveLength(4);
  const dynamic = analyze(file, { dynamic: true }).coverage;
  expect([...new Set(dynamic.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  expect(dynamic.diagnostics.filter((d) => d.code === "SC2020")).toHaveLength(2);
});

test("static AbortController method reads fence instead of yielding undefined", () => {
  const file = probeFile({
    id: "stdlib.abort-controller.method-read-fence",
    source:
      '/// <reference types="node" />\n' +
      'const controller = new AbortController();\n' +
      'void controller.abort;\n' +
      'void controller["abort"];\n' +
      'void controller.signal;\n',
  });
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  expect(coverage.diagnostics).toHaveLength(2);
  expect(
    coverage.diagnostics.every((d) =>
      d.message.includes(
        "AbortController.abort through method extraction in a static build",
      )
    ),
  ).toBe(true);

  const dynamic = analyze(file, { dynamic: true }).coverage;
  expect(dynamic.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(dynamic.stats.statementsFailed).toBe(0);
});

test("static fetch data properties remain destructurable in JavaScript", () => {
  const dir = join(probeRoot, "fetch-static-data-binding");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.js");
  writeFileSync(
    file,
      '/** @param {Response} response */\n' +
      'function readResponse(response) {\n' +
      '  const { status, ok } = response;\n' +
      '  console.log(status, ok);\n' +
      '}\n' +
      'void readResponse;\n',
  );
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("unimplemented Response and ReadableStream calls stay fenced under --dynamic", () => {
  const file = probeFile({
    id: "stdlib.fetch.unimplemented-dynamic-methods",
    source:
      '/// <reference types="node" />\n' +
      'function response(value: Response): void {\n' +
      '  void value.clone(); void value.blob(); void value.formData();\n' +
      '}\n' +
      'function stream(value: ReadableStream<Uint8Array>): void {\n' +
      '  void value.tee(); void value.pipeTo(null as never);\n' +
      '}\n' +
      'void response; void stream;\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
    expect(coverage.diagnostics.filter((d) => d.code === "SC2020")).toHaveLength(5);
  }
});

test("unsupported symbol object bindings remain fenced under --dynamic", () => {
  const file = probeFile({
    id: "stdlib.fetch.object-binding-unsupported-symbol",
    source:
      '/// <reference types="node" />\n' +
      'function stream(value: ReadableStream<Uint8Array>): void {\n' +
      '  const { [Symbol.asyncIterator]: iterator } = value;\n' +
      '}\n' +
      'void stream;\n',
  });
  for (const dynamic of [false, true]) {
    const coverage = analyze(file, { dynamic }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  }
});

test("constructing a spread RequestInit does not apply fetch conversion fences", () => {
  const root = mkdtempSync(join(tmpdir(), "scr-request-init-value-"));
  const file = join(root, "main.ts");
  writeFileSync(
    file,
    'interface RequestInit { cache?: "no-store"; }\n' +
      'const base = { cache: "no-store" } as const;\n' +
      'const init: RequestInit = { ...base };\n' +
      'void init;\n',
  );
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

/* ── attestation ↔ fence parity: the ask-5 §4 invariant's ground ─────────
 * The library sidecar's `deterministic` attestation demotes on libCall
 * spellings by prefix (ir/ir.ts's LIB_NONDETERMINISTIC_PREFIXES); the
 * profile's determinism fences deny surfaces by manifest id. The §4
 * invariant — a program that compiles under full fences attests
 * deterministic: true — holds only if every spelling the attestation
 * demotes on is deniable through some manifest entry's fence detector.
 * This test holds the two scans to that, mechanically, over the exhaustive
 * IrLibFn registry: a new ambient spelling added to a lowering fails here
 * until a manifest entry (or an alias on an existing one) covers it. */
describe("determinism attestation ↔ fence parity", () => {
  test("every attestation-demoting libFn spelling is deniable by a manifest-id fence", () => {
    // The full-fence declaration set: every ambient family the attestation
    // knows, spelled the way a profile would spell it.
    const resolved = resolveLibraryFences([
      { path: "parity[0]", id: "stdlib.math.random" },
      { path: "parity[1]", prefix: "node-builtin.fs." },
      { path: "parity[2]", prefix: "node-builtin.os." },
      { path: "parity[3]", prefix: "node-builtin.crypto." },
      { path: "parity[4]", prefix: "stdlib.date." },
      { path: "parity[5]", prefix: "node-builtin.process." },
      { path: "parity[6]", prefix: "node-builtin.perf_hooks." },
      // The host CA store (tlsca.*): the trust anchors are machine
      // identity, so the attestation demotes on them like os.* — the
      // family needs its own declaration here, not just manifest entries.
      { path: "parity[7]", prefix: "node-builtin.tls." },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const covered = new Set<string>();
    for (const fence of resolved.fences) {
      for (const s of fence.surfaces) {
        for (const fn of s.detector?.libFns ?? []) covered.add(fn);
      }
    }
    // Spellings the attestation demotes on that no fence detector needs to
    // witness, pinned WITH REASONS — additions here require the same
    // scrutiny as a manifest entry:
    const excused = new Set([
      // Refused SC4005 in library mode before any fence runs (the async
      // fs callback surface — LIB_MODE_REFUSED_PREFIXES).
      "fs.existsChk",
      // The JS-source validation-ladder spellings whose honest tail is a
      // compile-rendered runtime fence: the ladder replicates Node's typed
      // argument errors and then FENCES — the ambient operation never
      // runs, so the attestation's demote is pure conservatism.
      "fs.mkdtempChk",
      "fs.readFileChk",
      "fs.opendirChk",
      "fs.watchFileChk",
      "fs.lchmodChk",
      "fs.readChk",
      "fs.streamOptsChk",
      // fs._toUnixTimestamp — Node's underscore-stable seconds coercion
      // (the utimes ladder's time argument): it reads the clock only for
      // negative inputs, and the member is undeclared in @types/node, so
      // only the JS lane reaches it. A residual, documented gap: no
      // manifest member exists to hang a detector on yet.
      "fs.toUnixTimestamp",
    ]);
    const missing = Object.keys(LIB_FN_SIGS).filter(
      (fn) =>
        ir.LIB_NONDETERMINISTIC_PREFIXES.some(([prefix]) => fn.startsWith(prefix)) &&
        !covered.has(fn) &&
        !excused.has(fn),
    );
    expect(
      missing,
      "attestation-demoting spellings no declarable fence can deny — add a manifest projection (AMBIENT_SURFACE_FNS) or a member alias (BUILTIN_MODULE_FN_ALIASES)",
    ).toEqual([]);
    // The excuse list stays honest in the other direction too: an excused
    // spelling that gains detector coverage must leave the list.
    expect([...excused].filter((fn) => covered.has(fn))).toEqual([]);
  });
});
