import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyze,
  generateSurfaceManifest,
  ir,
  libFnSignatures,
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
    // The compiler and every shipped native package publish in lockstep; a drifted stamp would make
    // the spine ambiguous for a version pin.
    expect(readJson("packages/compiler/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-darwin-arm64/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-darwin-x64/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-linux-x64-gnu/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-linux-arm64-gnu/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-linux-x64-musl/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-linux-arm64-musl/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-win32-x64-msvc/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime-wasm32-wasi/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-darwin-arm64/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-darwin-x64/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-linux-x64-gnu/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-linux-arm64-gnu/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-linux-x64-musl/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-linux-arm64-musl/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/llvm-win32-x64-msvc/package.json").version).toBe(releaseVersion);
    for (const platform of ["linux-x64-gnu", "linux-arm64-gnu", "darwin-arm64", "darwin-x64"]) {
      expect(readJson(`packages/libnode-${platform}/package.json`).version).toBe(releaseVersion);
    }
  });

  test("schema: ids unique and sorted, enums valid, codes on every non-static entry", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.entries.length).toBeGreaterThan(0);
    const ids = manifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const e of manifest.entries) {
      expect(e.id).toMatch(/^[a-z][a-z0-9-]*(\.[A-Za-z0-9$_-]+)+$/);
      expect(["syntax", "stdlib", "node-builtin", "diagnostic-fence"]).toContain(e.kind);
      expect(["static", "unsupported"]).toContain(e.status);
      if (e.status !== "static") {
        expect(e.code, `${e.id}: non-static entries must carry their diagnostic code`).toMatch(
          /^SC\d{4}$/,
        );
      }
    }
    // Every kind and every status class is populated — an empty class
    // means a projection source dropped out without an error.
    for (const kind of ["syntax", "stdlib", "node-builtin", "diagnostic-fence"]) {
      expect(
        manifest.entries.some((e) => e.kind === kind),
        `no ${kind} entries`,
      ).toBe(true);
    }
    for (const status of ["static", "unsupported"]) {
      expect(
        manifest.entries.some((e) => e.status === status),
        `no ${status} entries`,
      ).toBe(true);
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

test("unsupported RequestInit keys remain fenced when const-computed", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.cache.computed",
    source:
      '/// <reference types="node" />\nconst option = "cache" as const;\nvoid fetch("http://127.0.0.1", { [option]: "no-store" });\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  {
    const { coverage } = analyze(file, {});
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
  writeFileSync(initFile, 'export const init = { method: "GET", cache: "no-store" } as const;\n');
  writeFileSync(
    mainFile,
    'import { init } from "./init.js";\nvoid fetch("http://127.0.0.1", init);\n',
  );
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  {
    const { coverage } = analyze(mainFile, {});
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
      "const enabled = true;\n" +
      'const init: RequestInit = enabled ? { cache: "no-store" } : { method: "GET" };\n' +
      'void fetch("http://127.0.0.1", init);\n' +
      "const disabled = false;\n" +
      'const safe: RequestInit = disabled ? { cache: "no-store" } : { method: "GET" };\n' +
      'void fetch("http://127.0.0.1", safe);\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(coverage.diagnostics.filter((d) => d.code === entry!.code)).toHaveLength(2);
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
  {
    const { coverage } = analyze(file, {});
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
  {
    const coverage = analyze(file, {}).coverage;
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
      "init.cache = undefined;\n" +
      'void fetch("http://127.0.0.1", init);\n',
  });
  {
    const coverage = analyze(file, {}).coverage;
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
      "const { wrapper: { init } } = options;\n" +
      'void fetch("http://127.0.0.1", init);\n' +
      'const tuple = [{ cache: "no-store" }] as const;\n' +
      "const [tupleInit] = tuple;\n" +
      'void fetch("http://127.0.0.1", tupleInit);\n',
  });
  const entry = entryById.get("stdlib.fetch.request-init.cache");
  expect(entry).toBeDefined();
  {
    const coverage = analyze(file, {}).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
    expect(coverage.diagnostics.filter((d) => d.code === entry!.code)).toHaveLength(2);
  }
});

test("RequestInit literals accept supported const-computed keys", () => {
  const file = probeFile({
    id: "stdlib.fetch.request-init.method.computed",
    source:
      '/// <reference types="node" />\n' +
      'const option = "method" as const;\n' +
      'void fetch("http://127.0.0.1", { [option]: "GET" });\n',
  });
  {
    const coverage = analyze(file, {}).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("finite unions of unsupported Headers members retain the native fence", () => {
  const file = probeFile({
    id: "stdlib.headers.dynamic-member-union",
    source:
      '/// <reference types="node" />\n' +
      "async function f(select: boolean): Promise<void> {\n" +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const member: "keys" | "values" = select ? "keys" : "values";\n' +
      "  void response.headers[member]();\n" +
      "}\n" +
      "void f;\n",
  });
  const entry = entryById.get("stdlib.headers.keys");
  expect(entry).toBeDefined();
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual([entry!.code]);
  expect(coverage.diagnostics).toHaveLength(1);
  expect(coverage.diagnostics[0]!.message).toContain("Headers.keys");
});

test("fetch handle method calls retain their receiver through bracket spellings", () => {
  const file = probeFile({
    id: "stdlib.fetch.bracket-method-calls",
    source:
      '/// <reference types="node" />\n' +
      "async function f(): Promise<void> {\n" +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const header: string | null = response.headers["get"]("x-kind");\n' +
      '  const text: string = await response["text"]();\n' +
      '  const member: "get" | "has" = header === null ? "get" : "has";\n' +
      '  const selected: string | boolean | null = response.headers[member]("x-kind");\n' +
      "  void text; void selected;\n" +
      "}\n" +
      "void f;\n",
  });
  {
    const coverage = analyze(file, {}).coverage;
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
      "async function f(select: boolean): Promise<void> {\n" +
      '  const response = await fetch("http://127.0.0.1");\n' +
      '  const member: "text" | "bytes" = select ? "text" : "bytes";\n' +
      "  const body: string | Uint8Array = await response[member]();\n" +
      "  void body;\n" +
      "}\n" +
      "void f;\n",
  });
  const coverage = analyze(file).coverage;
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("fetch companion surplus arguments remain supported natively", () => {
  const dir = join(probeRoot, "fetch-companion-surplus");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.js");
  writeFileSync(
    file,
    "const side = () => 1;\n" +
      "void AbortSignal.abort(undefined, side());\n" +
      "void AbortSignal.timeout(1, side());\n" +
      "void AbortSignal.any([], side());\n" +
      "void ReadableStream.from([], side());\n",
  );
  {
    const coverage = analyze(file, {}).coverage;
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
      "function headers(value: Headers): void { const { entries } = value; }\n" +
      "function response(value: Response): void { const { blob } = value; }\n" +
      "function stream(value: ReadableStream<Uint8Array>): void { const { tee } = value; }\n" +
      "function assign(value: Headers, entries: unknown): void { ({ entries } = value); }\n" +
      "void headers; void response; void stream; void assign;\n",
  });
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  expect(coverage.diagnostics.filter((d) => d.code === "SC2020")).toHaveLength(4);
});

test("static AbortController method reads fence instead of yielding undefined", () => {
  const file = probeFile({
    id: "stdlib.abort-controller.method-read-fence",
    source:
      '/// <reference types="node" />\n' +
      "const controller = new AbortController();\n" +
      "void controller.abort;\n" +
      'void controller["abort"];\n' +
      "void controller.signal;\n",
  });
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
  expect(coverage.diagnostics).toHaveLength(2);
  expect(
    coverage.diagnostics.every((d) =>
      d.message.includes("AbortController.abort through method extraction in a static build"),
    ),
  ).toBe(true);
});

test("static fetch data properties remain destructurable in JavaScript", () => {
  const dir = join(probeRoot, "fetch-static-data-binding");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.js");
  writeFileSync(
    file,
    "/** @param {Response} response */\n" +
      "function readResponse(response) {\n" +
      "  const { status, ok } = response;\n" +
      "  console.log(status, ok);\n" +
      "}\n" +
      "void readResponse;\n",
  );
  {
    const coverage = analyze(file, {}).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  }
});

test("unimplemented Response and ReadableStream calls stay fenced", () => {
  const file = probeFile({
    id: "stdlib.fetch.unimplemented-dynamic-methods",
    source:
      '/// <reference types="node" />\n' +
      "function response(value: Response): void {\n" +
      "  void value.blob(); void value.formData();\n" +
      "}\n" +
      "function stream(value: ReadableStream<Uint8Array>): void {\n" +
      "  void value.values(); void value[Symbol.asyncIterator]();\n" +
      "}\n" +
      "void response; void stream;\n",
  });
  {
    const coverage = analyze(file, {}).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect([...new Set(coverage.diagnostics.map((d) => d.code))]).toEqual(["SC2020"]);
    expect(coverage.diagnostics.filter((d) => d.code === "SC2020")).toHaveLength(4);
  }
});

test("unsupported symbol object bindings remain fenced", () => {
  const file = probeFile({
    id: "stdlib.fetch.object-binding-unsupported-symbol",
    source:
      '/// <reference types="node" />\n' +
      "function stream(value: ReadableStream<Uint8Array>): void {\n" +
      "  const { [Symbol.asyncIterator]: iterator } = value;\n" +
      "}\n" +
      "void stream;\n",
  });
  {
    const coverage = analyze(file, {}).coverage;
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
      "const init: RequestInit = { ...base };\n" +
      "void init;\n",
  );
  const { coverage } = analyze(file);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

/* ── attestation ↔ fence parity: the ask-5 §4 invariant's ground ─────────
 * The library sidecar's `deterministic` attestation demotes on libCall
 * spellings by prefix (library/ir-policy.ts's LIB_NONDETERMINISTIC_PREFIXES); the
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
      // new File() reads the clock for an absent lastModified.
      { path: "parity[8]", id: "stdlib.file" },
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
      // Validates/unboxes a native Date handle without reading ambient
      // state. lowerDateCall emits it only as the receiver of a separately
      // witnessed Date method; assigning it to getTime would also deny
      // valueOf/toISOString/etc. under a getTime-only fence.
      "date.checkedValue",
      // Makes a Date from the time value a Date local holds
      // (date-values.ts) without reading ambient state. The local's
      // initializer is the Date expression the fences witness.
      "date.fromTime",
    ]);
    const missing = Object.keys(libFnSignatures()).filter(
      (fn) =>
        ir.LIB_NONDETERMINISTIC_PREFIXES.some(([prefix]) => fn.startsWith(prefix)) &&
        !covered.has(fn) &&
        !excused.has(fn),
    );
    expect(
      missing,
      "attestation-demoting spellings no declarable fence can deny — add a manifest projection (ambientSurfaceFns()) or a member alias (BUILTIN_MODULE_FN_ALIASES)",
    ).toEqual([]);
    // The excuse list stays honest in the other direction too: an excused
    // spelling that gains detector coverage must leave the list.
    expect([...excused].filter((fn) => covered.has(fn))).toEqual([]);
  });
});
