/* npm imports under --dynamic: every fixture program under
 * tests/fixtures/npm/cases (plus the commander acceptance fixture) runs
 * under Node AND as a scriptc-compiled binary; stdout must match
 * byte-for-byte and exit codes must agree — the differential contract,
 * extended with argv (CLI packages parse process.argv).
 *
 * The fixture node_modules are COMMITTED TEST DATA (hand-made minimal
 * packages exercising ESM/CJS/dual/scoped/JSON resolution, and a pinned
 * real commander for the acceptance CLI). Binaries embed the package
 * sources at build time — nothing here reads node_modules at runtime.
 *
 * SCRIPTC_SAN=1 rebuilds everything with ASan + the runtime RC audit; the
 * island's counting allocator asserts zero live engine allocations at
 * teardown.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { npmCases } from "./npm-cases.js";
import { shardSelect, shardSuffix } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// The case table lives in npm-cases.ts: the Linux lane runs the identical
// cases (same entries, same argv lists) inside its container. The shard
// split (SCRIPTC_TEST_SHARD, CI's matrix) is applied HERE, not in the
// table, so that lane keeps its full list.
const cases = shardSelect(npmCases(fixturesRoot), (c) => c.name);

interface RunResult {
  stdout: Buffer;
  exitCode: number;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  try {
    // stdin closes immediately (differential.test.ts's contract): fixture
    // programs may read fd 0 to EOF (process.stdin is a real Readable in
    // the island now), and a default open pipe would hang both lanes.
    const pending = execFileAsync(cmd, args, { encoding: "buffer" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout)) throw err;
    return { stdout: e.stdout, exitCode: e.code };
  }
}

/** Compile once per (entry, lane); the cache key hashes the program AND
 * the fixture packages so edits to either rebuild. */
async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const fixtureDir = join(entry, "../..");
  const inputs = [
    entry,
    ...globSync(join(fixtureDir, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts,node}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `npm-${key}`);
  mkdirSync(outDir, { recursive: true });
  // Deliberately NO backend pin: this suite rides the release default.
  // Embedded npm tables are production LLVM surface; this differential
  // keeps package resolution, compressed source storage, and island/runtime
  // boundaries covered through the backend that ships.
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
  });
  if (!result.ok) {
    throw new Error(
      "npm fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe(`typed-callback boundary (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  // The one deliberate DIVERGENCE at the typed-callback boundary: a package
  // argument the declared param type refuses becomes a TypeError thrown
  // back into the island before the body runs (Node would run the body
  // with the lie) — so this program is asserted directly, never
  // differentially. SEMANTICS.md documents it with the dyn→static edges.
  test("a lying engine argument throws a TypeError into the package", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/main.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "caught:true:expected number, got string\n" +
        "caught:true:expected object at $, got number\n",
    );
    expect(res.exitCode).toBe(0);
  }, 120_000);

  // The lazy-builtin trap (the divergent third of the lazy edge semantics
  // lazy-traps pins differentially): a require() of an unshimmed Node
  // BUILTIN — esbundled's __require("net") — builds fine (the lazy edge
  // embeds pointing at the refused node: key) and throws the island's own
  // error AT THE CALL. Node would LOAD core net here, so this program
  // is asserted directly, never differentially.
  test("require of an unshimmed builtin throws the island's lazy error at the call", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/lazybuiltin.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "the island does not provide the 'node:http2' builtin\n",
    );
    expect(res.exitCode).toBe(0);
  }, 120_000);

  // The native-addon trap (the .node sibling of the lazy-builtin trap):
  // a napi-style package's require of its .node binding embeds a throwing
  // ERR_DLOPEN_FAILED stub, never the addon's machine code. Node dlopens
  // the garbage fixture and fails with a PLATFORM-worded message, so the
  // shape probes would agree differentially but the message probe cannot —
  // asserted directly. Pins: the code, the retry (a throwing module leaves
  // no cache entry), ".node" in the require extension candidates, and the
  // island's exact message.
  test("require of a .node native addon throws ERR_DLOPEN_FAILED at the call", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/nativeaddon.ts"));
    const res = await runBinary(binary, []);
    const addonKey = realpathSync(join(fixturesRoot, "npm/node_modules/nativezoo/addon.node"));
    expect(res.stdout.toString("utf8")).toBe(
      "caught:true:ERR_DLOPEN_FAILED\n" +
        "caught:true:ERR_DLOPEN_FAILED\n" +
        "caught:true:ERR_DLOPEN_FAILED\n" +
        `Cannot load native addon '${addonKey}': scriptc binaries cannot load .node addons (the island has no process.dlopen)\n`,
    );
    expect(res.exitCode).toBe(0);
  }, 120_000);

  // The island's WebAssembly is a THROWING STUB (SEMANTICS.md): Node has a
  // real wasm engine, so this surface is asserted directly, never
  // differentially. The promise-shaped members REJECT with the clear
  // message (the real API's shape — invalid bytes reject, never throw
  // synchronously — so top-level `WebAssembly.compile(...)` module
  // evaluation stays lazy exactly as under Node: es-module-lexer's
  // `export const init`, undici's lazyllhttp), the error classes are real
  // Error subclasses (Emscripten's abort path constructs a working
  // RuntimeError), and validate() answers false.
  test("WebAssembly is a rejecting stub with real error classes", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/wasm.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "WebAssembly.instantiate is not supported in scriptc binaries (the embedded engine has no wasm runtime)\n" +
        "true|RuntimeError|Aborted(Error: boom)\n" +
        "false\n",
    );
    expect(res.exitCode).toBe(0);
  }, 120_000);
});

describe(`npm differential (${cases.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    for (const argv of c.argvs ?? [[]]) {
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [c.entry, ...argv]),
        runBinary(binary, argv),
      ]);
      const label = argv.join(" ");
      if (!nodeRes.stdout.equals(nativeRes.stdout)) {
        expect(nativeRes.stdout.toString("utf8"), label).toBe(nodeRes.stdout.toString("utf8"));
        expect.unreachable("stdout differed at byte level but not after utf8 decode");
      }
      expect(nativeRes.exitCode, label).toBe(nodeRes.exitCode);
    }
  }, 120_000);
});
