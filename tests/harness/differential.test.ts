/* The oracle: every corpus program runs under Node AND as a scriptc-compiled
 * native binary; stdout AND stderr must match byte-for-byte and exit codes
 * must agree (stderr only for exit-0 programs: the uncaught-throw report
 * format is a documented divergence, so `// @exit:` programs keep the
 * historical stdout-only contract).
 * No golden files — Node IS the expected output, so tests can't drift.
 *
 * SCRIPTC_SAN=1 re-runs every program built with ASan + the runtime RC audit,
 * turning the whole corpus into leak/use-after-free tests (default in CI).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

// Flat single-file tests plus directory tests (<name>/main.<ext> as the
// entry with sibling modules). JavaScript entries (.js/.mjs/.cjs) are
// first-class corpus programs: Node runs them directly (no type strip),
// scriptc compiles them through checkJs inference.
// SCRIPTC_TEST_SHARD="i/n" (CI's matrix) keeps only this shard's slice of
// the corpus — the file is this suite's wall-time monster, so vitest's
// file-granular --shard alone cannot split it. Unset = everything.
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = shardSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ]).sort(),
  (f) => f.slice(corpusDir.length + 1),
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// Both children (node and the native binary) inherit this process's env, so
// corpus programs can read a KNOWN variable value-exactly — not just the
// presence of machine-dependent ones like PATH.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** The directive head of a corpus program: its first TWO lines, so a
 * program can combine directives (`// @exit: 1` + `// @transform-types`),
 * one per line. */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

/** Expected exit code of a corpus program: 0 unless the entry file's head
 * says otherwise (`// @exit: 1` — uncaught-throw programs exit 1 under
 * Node and under scriptc; stderr is not compared there — the report format
 * is a documented divergence — stdout still is). */
function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** `// @dynamic` in the entry file's directive head: compile with the
 * island engine embedded (--dynamic). The Node side needs no flag — the
 * island shim (island-shim.mjs) makes __island_eval a global indirect
 * eval, so Node stays the oracle for island VALUE results. */
function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

/** `// @npm-static` in the entry file's directive head: compile through the
 * CLI with --npm-static auto — the flag's user-facing path, where the CLI
 * owns auto's transitive closure (express pulling its qs/send edges).
 * The bare compile() API takes a literal package list, so pinning the
 * closure through it would test the lane's own guess, not the product. */
function wantsNpmStatic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @npm-static\s*$/.test(l));
}

/** `// @transform-types` in the entry file's directive head: the Node
 * side runs with --experimental-transform-types — for corpus programs
 * using non-erasable TypeScript syntax (namespaces) that Node's default
 * strip-only mode refuses to parse. The transform IS the oracle there:
 * scriptc must match what Node executes under the flag. */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  // Enums are the other lowered construct with a runtime transform: programs
  // declaring one ride the same flag without a directive. The flags stay a
  // pure function of the program bytes, so the oracle cache key needs no
  // extension.
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators` in the entry file's directive head: the Node side
 * runs tsc's ES-decorator downlevel of the program (target ES2022) —
 * decorators are the one supported construct Node cannot execute AT ALL
 * (V8 has not shipped the proposal; both strip and transform modes leave
 * `@dec` in place and V8 rejects the syntax), so the reference downlevel
 * every decorator user ships to production IS the oracle. Single-file
 * programs only (the transform materializes one entry beside the cache).
 */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

/** The file the Node oracle executes: the program itself, or (decorator
 * programs) its deterministic ES2022 downlevel materialized under the
 * test cache — a pure function of the program bytes and the typescript
 * version (both in the oracle cache key). */
function nodeOracleFile(file: string): string {
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256").update(ts5.version).update("\0").update(src).digest("hex").slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: concurrent suites (the other flavor's full run, or
  // another lane over the same program) write this same content-keyed
  // path; rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

/** `// @no-deprecation` in the directive head: the Node oracle runs with
 * --no-deprecation — for programs exercising deprecated-API ERROR paths
 * (new Buffer's ctor ladder) whose DEP warnings carry a pid and can never
 * byte-compare; the compiled runtime emits no process warnings at all. */
function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

/** The Node oracle's argv for a corpus entry (shims + the per-program
 * transform flag). */
function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  return [...transform, ...nodep, "--import", comptimeShim, "--import", islandShim, nodeOracleFile(file)];
}

/** Runs a binary, tolerating an expected nonzero exit (execFile rejects on
 * any nonzero code; a signal death or missing stdout still throws). The
 * child's stdin closes immediately: corpus programs may read fd 0 to EOF
 * (readFileSync(0)), and the default open pipe would block both sides
 * forever — this way Node and the native binary see the same empty,
 * closed stream. */
async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  // Linux fork/exec race (observed on the sandbox lane, llvm flavor): a
  // sibling worker's fork can inherit the freshly-linked binary's write
  // fd across its own spawn window, and exec answers ETXTBSY until that
  // fd closes. The condition is transient by construction — retry
  // briefly, the npm/cargo stance. (No-op on macOS: exec there never
  // answers ETXTBSY.)
  for (let attempt = 0; ; attempt++) {
    const pending = execFileAsync(cmd, args, { encoding: "buffer" });
    pending.child.stdin?.end();
    try {
      const { stdout, stderr } = await pending;
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
      if (e.code === "ETXTBSY" && attempt < 10) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
        throw err;
      }
      return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
    }
  }
}

/** The native lane's stderr, normalized for comparison: sanitized builds
 * may append the RC-audit skip notice for deliberately abandoned fibers
 * (scriptc-only diagnostics, not program output) — dropped before the
 * byte comparison. Linux ASan additionally prints a once-per-process
 * warning at the first fiber swapcontext (no off switch in the
 * interceptor; Apple's ASan never intercepts ucontext) — same treatment. */
function comparableStderr(stderr: Buffer): Buffer {
  if (!sanitize) return stderr;
  const lines = stderr.toString("utf8").split("\n");
  const kept = lines.filter(
    (l) =>
      !l.startsWith("scriptc RC audit skipped:") &&
      !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(l),
  );
  return Buffer.from(kept.join("\n"), "utf8");
}

// `comptime(fn)` in plain JS semantics is just `fn()` — the shim defines it
// globally so Node stays the oracle for comptime programs (the compile-time
// result must equal what Node computes at runtime); inert for the rest.
const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
// `__island_eval(code)` in plain JS semantics is a global indirect eval +
// String() — the island shim defines it so Node stays the oracle for island
// programs too; inert for the rest.
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;

/** Entry file plus siblings for directory tests — every byte a program run
 * depends on, shared by the oracle cache key and the compile cache key.
 * Directory tests hash RECURSIVELY (nested modules like common/index.js)
 * plus the configs that steer both sides (tsconfig.json adoption,
 * package.json module-format detection). */
function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

// ---- oracle result cache ---------------------------------------------------
// Node's verdict for a corpus program is a pure function of the program bytes,
// the shims, and the Node build (corpus stdout is deterministic by
// construction — it must match a non-Node native binary byte-for-byte). So
// cache it, keyed by all of those plus the invocation shape (SCRIPTC_TEST_ENV
// and the cwd). Only the SPAWN is skipped: the native side always runs live
// and the comparison itself never changes. SCRIPTC_NO_CACHE=1 (or an unset
// SCRIPTC_CACHE_DIR) disables the cache in both directions — no reads, no writes.
// Storage shares the compile cache's root and its LRU sweep (see native-toolchain.ts).
const oracleDir =
  process.env["SCRIPTC_NO_CACHE"] !== "1" && process.env["SCRIPTC_CACHE_DIR"]
    ? join(process.env["SCRIPTC_CACHE_DIR"], "oracle")
    : null;
if (oracleDir !== null) mkdirSync(oracleDir, { recursive: true });

let oracleKeyBaseMemo: Promise<string> | null = null;
function oracleKeyBase(): Promise<string> {
  // The spawned `node` comes from PATH, so ask IT for its version rather than
  // trusting process.version (vitest's own node could differ).
  oracleKeyBaseMemo ??= execFileAsync("node", ["--version"]).then(({ stdout }) =>
    createHash("sha256")
      .update("oracle-v1\0")
      .update(stdout.trim()).update("\0")
      // Decorator programs run tsc's downlevel on the Node side — its
      // emitter version is part of the verdict.
      .update(ts5.version).update("\0")
      .update(readFileSync(fileURLToPath(comptimeShim))).update("\0")
      .update(readFileSync(fileURLToPath(islandShim))).update("\0")
      .update(process.env["SCRIPTC_TEST_ENV"] ?? "").update("\0")
      .update(process.cwd()).update("\0")
      .digest("hex"),
  );
  return oracleKeyBaseMemo;
}

/** Real-time programs are EXCLUDED from the oracle cache: a timer-interleave
 * program's stdout is only deterministic in the sense that Node and the
 * native binary agree when they run under the SAME instantaneous load
 * (the harness runs them concurrently). Caching Node's verdict from one run
 * and comparing it against a live native run later decouples the two sides —
 * a load-skewed interleave recorded once would keep failing until evicted
 * (observed with 1430-promise-race.ts). Those programs — 18 of 298 — always
 * spawn Node live. VOLATILE-HOST programs ride the same exclusion:
 * os.networkInterfaces output changes under the harness's feet (macOS
 * rotates the awdl0/llw0 link-local address), so a cached Node verdict
 * goes stale against a live native read (observed with 1480). The platform
 * certificate store is mutable host state too: a cached system-CA predicate
 * must not outlive an administrator or keychain change. */
function usesVolatileHostState(inputs: string[]): boolean {
  return inputs.some((f) =>
    /set(Timeout|Interval)|Promise\.(race|any)|networkInterfaces|getCACertificates\s*\(\s*["']system["']/.test(
      readFileSync(f, "utf8"),
    ),
  );
}

async function runNode(file: string): Promise<RunResult> {
  let cachePath: string | null = null;
  if (oracleDir !== null && !usesVolatileHostState(programInputs(file))) {
    const h = createHash("sha256").update(await oracleKeyBase());
    for (const f of programInputs(file)) {
      h.update(f.slice(repoRoot.length)).update("\0").update(readFileSync(f)).update("\0");
    }
    cachePath = join(oracleDir, `${h.digest("hex")}.json`);
    try {
      // v2 carries stderr (the harness compares it for exit-0 programs);
      // v1 records read as misses and rewrite themselves.
      const rec = JSON.parse(readFileSync(cachePath, "utf8")) as {
        v?: number;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      if (
        rec.v === 2 &&
        typeof rec.exitCode === "number" &&
        typeof rec.stdout === "string" &&
        typeof rec.stderr === "string"
      ) {
        const now = new Date();
        utimesSync(cachePath, now, now); // LRU bump for the shared sweep
        return {
          stdout: Buffer.from(rec.stdout, "base64"),
          stderr: Buffer.from(rec.stderr, "base64"),
          exitCode: rec.exitCode,
        };
      }
    } catch {
      /* miss (or unreadable record) — spawn Node below */
    }
  }
  // Node 24 strips types natively; the supported subset is erasable by
  // construction — except `// @transform-types` programs (namespaces),
  // which run under Node's transform mode.
  const res = await runBinary("node", nodeOracleArgs(file));
  if (cachePath !== null) {
    try {
      const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
      writeFileSync(
        tmp,
        JSON.stringify({
          v: 2,
          exitCode: res.exitCode,
          stdout: res.stdout.toString("base64"),
          stderr: res.stderr.toString("base64"),
        }),
      );
      renameSync(tmp, cachePath); // atomic publish; concurrent winners are equivalent
    } catch {
      /* caching is best-effort */
    }
  }
  return res;
}

async function compileAndRun(file: string): Promise<RunResult> {
  // Directory tests hash every sibling file so edits to imports bust the cache.
  const inputs = programInputs(file);
  const dynamic = wantsDynamic(file);
  const npmStatic = wantsNpmStatic(file);
  const hash = createHash("sha256");
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(dynamic ? "dyn" : "")
    .update(npmStatic ? "npm-auto" : "")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  let binaryPath: string;
  if (npmStatic) {
    // The CLI builds it: --npm-static auto rides main.ts's expansion, and
    // the C backend keeps this suite's pinned reference lane.
    const cliEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
    const res = await runBinary(process.execPath, [
      cliEntry,
      "build",
      file,
      "--backend",
      "c",
      "--out",
      join(outDir, "program"),
      "--npm-static",
      "auto",
      ...(dynamic ? ["--dynamic"] : []),
      ...(sanitize ? ["--sanitize"] : []),
    ]);
    if (res.exitCode !== 0) {
      throw new Error(
        `corpus program failed to compile via the CLI (--npm-static auto):\n` +
          res.stderr.toString("utf8") +
          res.stdout.toString("utf8"),
      );
    }
    binaryPath = res.stdout.toString("utf8").trim();
  } else {
    const result = await compile(file, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize,
      dynamic,
      // Pinned: this suite IS the C-reference lane — its meaning is "the C
      // backend matches Node", regardless of what the product default does.
      // llvm-differential.test.ts owns the LLVM lane over the same corpus.
      backend: "c",
    });
    if (!result.ok) {
      throw new Error(
        "corpus program failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }
    binaryPath = result.binaryPath;
  }
  return runBinary(binaryPath, []);
}

describe(`differential corpus (${files.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  // retry: absorbs ORACLE-side nondeterminism, not compiler bugs — a
  // deterministic byte mismatch fails both attempts. The concrete driver:
  // live-spawned Node itself can hang under heavy box load (1751's
  // fs.watch stalled five gates on 2026-07-20 while the compiled binary
  // answered in milliseconds every time).
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    { retry: 1 },
    async ([, file]) => {
      const [nodeRes, nativeRes] = await Promise.all([runNode(file), compileAndRun(file)]);
      // Compare as bytes; decode only for the failure diff.
      if (!nodeRes.stdout.equals(nativeRes.stdout)) {
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect.unreachable("stdout differed at byte level but not after utf8 decode");
      }
      // Both sides must agree with the declared expectation (default 0) —
      // asserting node's code too keeps `// @exit:` directives honest.
      const expectedExit = expectedExitCode(file);
      // stderr is part of the contract for exit-0 programs (console.error/
      // warn, process.stderr.write); nonzero-exit programs keep stdout-only
      // — their stderr carries the uncaught report, whose format is a
      // documented divergence.
      if (expectedExit === 0) {
        const nativeErr = comparableStderr(nativeRes.stderr);
        if (!nodeRes.stderr.equals(nativeErr)) {
          expect(nativeErr.toString("utf8")).toBe(nodeRes.stderr.toString("utf8"));
          expect.unreachable("stderr differed at byte level but not after utf8 decode");
        }
      }
      expect(nodeRes.exitCode).toBe(expectedExit);
      expect(nativeRes.exitCode).toBe(expectedExit);
    },
  );
});
