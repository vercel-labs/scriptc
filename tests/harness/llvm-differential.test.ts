/* The dual-backend differential: tier membership is AUTO-DISCOVERED by
 * attempting the LLVM build on every corpus program. A program the tier
 * claims must be byte-identical through BOTH backends — stdout (always),
 * stderr (exit-0 programs), exit code — and both must match the Node
 * oracle. A program outside the tier must REFUSE loudly under the
 * explicit `backend: "llvm"` pin this suite builds with: diagnostic
 * SC3001 naming the first unsupported IR construct, never wrong code.
 * (The RELEASE default is LLVM with a transparent C fallback; the pin is
 * exactly how this suite keeps refusals loud. Each refused program is
 * additionally rebuilt through the default lane below, asserting the
 * fallback lands on the C backend with the same refusal kind recorded.)
 *
 * SCRIPTC_SAN=1 rebuilds both lanes with ASan + the runtime RC audit; the
 * emitted .ll opts its functions into instrumentation via sanitize_address,
 * so the LLVM-emitted frames are covered too. The refusal histogram and
 * the claimed count print at the end — phase 2's queue.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

// Same corpus, same SCRIPTC_TEST_SHARD slice as differential.test.ts (the
// two files split identically, so a shard's compile cache serves both lanes).
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = shardSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ]).sort(),
  (f) => f.slice(corpusDir.length + 1),
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const helperOnly = process.env["SCRIPTC_LLVM_HELPER_ONLY"] === "1";

// Same known-env contract as the main differential suite.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

/** The survey's six in-tier programs: the tier floor. Auto-discovery may
 * claim MORE (it does — strings/globals joined in phase 1), but these six
 * regressing out of the tier is always a bug, so they are pinned. */
const TIER_FLOOR = [
  "001-hello.ts",
  "002-log-args.ts",
  "100-number-format.ts",
  "101-arithmetic.ts",
  "400-fib.ts",
  "401-mutual-recursion.ts",
];

/** Fixed backend gaps whose corpus programs must remain in the LLVM tier. */
const TIER_REGRESSIONS = [
  "2672-http-request-response-callback.ts",
];

/** Phase 2 object-emission floor: these claimed corpus cases pin every
 * required helper-validation family. TLS server creation remains one of the
 * six explicit SC3001 refusals outside this floor. */
const HELPER_TIER_FLOOR = [
  "1020-async-basics.ts",
  "2010-generators-basics.ts",
  "984-exceptions-finally.ts",
  "1100-island-eval-basics.ts",
  "1200-regex-test-basics.ts",
  "2672-http-request-response-callback.ts",
  "1404-zlib-crypto-bytes.ts",
  "2557-tls-ca-store.ts",
];

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** First TWO lines — a program can combine directives, one per line
 * (differential.test.ts's directiveHead). */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  // Linux fork/exec race (observed on the sandbox lane): a sibling
  // worker's fork can inherit the freshly-linked binary's write fd across
  // its own spawn window, and exec answers ETXTBSY until that fd closes.
  // The condition is transient by construction — retry briefly, the
  // npm/cargo stance.
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

function comparableStderr(stderr: Buffer): Buffer {
  if (!sanitize) return stderr;
  const lines = stderr.toString("utf8").split("\n");
  const kept = lines.filter(
    (l) =>
      !l.startsWith("scriptc RC audit skipped:") &&
      // Linux ASan's once-per-process fiber-swapcontext warning (see
      // differential.test.ts's comparableStderr).
      !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(l),
  );
  return Buffer.from(kept.join("\n"), "utf8");
}

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;

/** differential.test.ts's twin: the Node oracle runs with
 * --experimental-transform-types for corpus programs using non-erasable
 * syntax — the `// @transform-types` directive (namespaces) OR any enum
 * declaration (strip-only mode refuses to parse enums, no directive
 * needed; a pure function of the program bytes). */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators` (differential.test.ts's twin): decorators are the
 * one supported construct Node cannot execute at all, so the oracle runs
 * tsc's deterministic ES2022 downlevel materialized under the test cache. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

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

function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  return [...transform, ...nodep, "--import", comptimeShim, "--import", islandShim, nodeOracleFile(file)];
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

async function build(file: string, backend: "c" | "llvm" | "helper" | "default") {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  // "llvm-c" (not the bare key differential.test.ts computes) keeps this
  // suite's C-lane binaries in their OWN cache slots: compile() always
  // rewrites its output, so sharing paths with the main differential
  // means one suite can relink a binary the other is exec'ing — Linux
  // answers ETXTBSY (observed on the sandbox lane as claims grew).
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(wantsDynamic(file) ? "dyn" : "")
    .update(backend === "llvm" ? "llvm" : backend === "helper" ? "llvm-helper" : backend === "c" ? "llvm-c" : "llvm-def")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  // The binary BASENAME must be unique per lane (and per flavor): fs-corpus
  // programs derive their scratch paths from tail(process.argv[1]) — the
  // basename — so two concurrently running native binaries that share a
  // name share a scratch directory and corrupt each other's fs state. This
  // suite runs its LLVM and C binaries concurrently (the Promise.all
  // below), and the main differential's C binary ("program") for the same
  // fixture can run in a sibling worker at the same time; the node oracle
  // is safe on its own (argv[1] is the .ts path). Observed on the public
  // CI runner as the seven fs/path llvm-differential failures of run
  // 29965245855 — empty or interleaved stdout on whichever lane lost the
  // race, reproducible locally by racing the two same-named binaries.
  const lane = backend === "llvm" ? "program-llvm" : backend === "helper" ? "program-llvmhelper" : backend === "c" ? "program-llvmc" : "program-llvmdef";
  return compile(file, {
    outPath: join(outDir, `${lane}${sanitize ? "-san" : ""}`),
    outDir,
    sanitize,
    dynamic: wantsDynamic(file),
    // "default" leaves the option unset — the release default's
    // LLVM-with-transparent-C-fallback lane, exercised on refusals below.
    ...(backend === "default" ? {} : { backend: backend === "helper" ? "llvm" as const : backend }),
    ...(backend === "helper" ? { nativeProgramObject: true } : {}),
  });
}

// Auto-discovery ledger, summarized after the run: which programs the tier
// claims, and which IR kinds gate the rest (phase 2's queue).
// SCRIPTC_LLVM_REFUSALS=1 additionally lists every refused program under
// its kind — the burn-down view the phase reports work from.
const claimed: string[] = [];
const refusalKinds = new Map<string, number>();
const refusalPrograms = new Map<string, string[]>();

describe(`llvm differential corpus (${files.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    async ([rel, file]) => {
      const llvmRes = await build(file, "llvm");
      if (!llvmRes.ok) {
        // Out of tier: the refusal must be LOUD and must be THE refusal —
        // exactly one SC3001 naming the first unhandled construct. Any
        // other diagnostic here means a corpus program stopped compiling
        // at all, which the main differential suite forbids.
        expect(llvmRes.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
        const kind = /\(([^)]+)\)/.exec(llvmRes.diagnostics[0]!.message)?.[1] ?? "?";
        refusalKinds.set(kind, (refusalKinds.get(kind) ?? 0) + 1);
        refusalPrograms.set(kind, [...(refusalPrograms.get(kind) ?? []), rel]);
        // The release default must land this same program on the C lane
        // TRANSPARENTLY: one frontend pass, the emit retried through the
        // C backend, the refusal recorded — never a failed build.
        const defRes = await build(file, "default");
        if (!defRes.ok) throw new Error(`the default lane failed to fall back on a refused program: ${rel}`);
        expect(defRes.backend).toBe("c");
        expect(defRes.llvmRefusal).toBe(kind);
        expect(defRes.cPath.endsWith(".c")).toBe(true);
        return;
      }
      claimed.push(rel);
      expect(llvmRes.backend).toBe("llvm");
      expect(llvmRes.llvmRefusal).toBeUndefined();
      expect(llvmRes.cPath.endsWith(".ll")).toBe(true);

      if (helperOnly) {
        if (sanitize) throw new Error("the helper object lane does not support sanitizer mode");
        if (process.platform !== "darwin" || process.arch !== "arm64" ||
            Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) < 24) {
          throw new Error("the helper object lane requires macOS 15+ arm64");
        }
        const helperRes = await build(file, "helper");
        if (!helperRes.ok) {
          throw new Error(
            `LLVM helper object emission failed on a program the LLVM tier claims: ${rel}: ` +
            helperRes.diagnostics.map((d) => `${d.code} ${d.message}`).join("; "),
          );
        }
        const [llvm, helper] = await Promise.all([
          runBinary(llvmRes.binaryPath, []),
          runBinary(helperRes.binaryPath, []),
        ]);
        expect(helper.stdout, `helper object stdout differed for ${rel}`).toEqual(llvm.stdout);
        if (helper.exitCode === 0) {
          expect(comparableStderr(helper.stderr), `helper object stderr differed for ${rel}`)
            .toEqual(comparableStderr(llvm.stderr));
        }
        expect(helper.exitCode, `helper object exit code differed for ${rel}`).toBe(llvm.exitCode);
        return;
      }

      const cRes = await build(file, "c");
      if (!cRes.ok) throw new Error(`C backend failed on a program the LLVM tier claims: ${rel}`);
      expect(cRes.backend).toBe("c");
      const [llvm, c, node] = await Promise.all([
        runBinary(llvmRes.binaryPath, []),
        runBinary(cRes.binaryPath, []),
        runBinary("node", nodeOracleArgs(file)),
      ]);

      // stdout: byte parity across all three lanes.
      if (!llvm.stdout.equals(c.stdout)) {
        expect(llvm.stdout.toString("utf8")).toBe(c.stdout.toString("utf8"));
        expect.unreachable("llvm-vs-c stdout differed at byte level but not after utf8 decode");
      }
      if (!llvm.stdout.equals(node.stdout)) {
        expect(llvm.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
        expect.unreachable("llvm-vs-node stdout differed at byte level but not after utf8 decode");
      }
      // stderr: the exit-0 contract of the main differential suite.
      const expectedExit = expectedExitCode(file);
      if (expectedExit === 0) {
        const llvmErr = comparableStderr(llvm.stderr);
        const cErr = comparableStderr(c.stderr);
        if (!llvmErr.equals(cErr)) {
          expect(llvmErr.toString("utf8")).toBe(cErr.toString("utf8"));
        }
        if (!llvmErr.equals(node.stderr)) {
          expect(llvmErr.toString("utf8")).toBe(node.stderr.toString("utf8"));
        }
      }
      expect(llvm.exitCode).toBe(expectedExit);
      expect(c.exitCode).toBe(expectedExit);
      expect(node.exitCode).toBe(expectedExit);
    },
  );

  test("tier floor: the survey's six programs stay claimed", () => {
    // Under a shard, only the floor programs THIS slice ran can be asserted
    // (same key as the corpus split above); the shard union covers all six.
    for (const name of shardSelect(TIER_FLOOR, (n) => n)) {
      expect(claimed, `${name} regressed out of the LLVM tier`).toContain(name);
    }
  });

  test("fixed tier regressions stay claimed", () => {
    for (const name of shardSelect(TIER_REGRESSIONS, (n) => n)) {
      expect(claimed, `${name} regressed out of the LLVM tier`).toContain(name);
    }
  });

  test.skipIf(!helperOnly)("helper object feature floor stays claimed", () => {
    for (const name of shardSelect(HELPER_TIER_FLOOR, (n) => n)) {
      expect(claimed, `${name} regressed out of helper object emission`).toContain(name);
    }
  });

  afterAll(() => {
    const hist = [...refusalKinds].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line no-console
    console.info(
      `llvm tier: ${claimed.length}/${files.length} corpus programs claimed; ` +
        `top refusals: ${hist.slice(0, 8).map(([k, n]) => `${k}×${n}`).join(", ")}`,
    );
    if (process.env["SCRIPTC_LLVM_REFUSALS"] === "1") {
      for (const [kind] of hist) {
        // eslint-disable-next-line no-console
        console.info(`  ${kind}: ${refusalPrograms.get(kind)!.join(" ")}`);
      }
    }
  });
});
