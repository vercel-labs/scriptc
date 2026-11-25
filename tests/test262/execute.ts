import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertThrowsSource, compileFailureStatus, completion, harnessSource, prepare, prepareIsland, scriptEnvironment } from "./support.mjs";

export interface Outcome {
  status: string;
  reason?: string;
  phase?: string;
  backend?: string;
  /** The entry module the compiler put in a Node island (decision S4): the
   * result is then `island-pass`/`island-fail`, never a native pass. */
  island?: true;
  stdout?: string;
  stderr?: string;
  diagnostics?: unknown[];
  workDir?: string;
}

interface ProcessResult {
  code: number | null;
  signal: string | null;
  timeout: boolean;
  overflow: boolean;
  stdout: string;
  stderr: string;
}

export function boundedRun(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let stdout = "";
    let stderr = "";
    let timeout = false;
    let overflow = false;
    const stop = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      }
    };
    const timer = setTimeout(() => { timeout = true; stop(); }, timeoutMs);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (overflow) return;
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; stop(); }
    };
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timeout, overflow, stdout, stderr });
    });
  });
}

/** Whether two spellings name the same file (macOS resolves /var through
 * /private/var, so the compiler may report the longer one). */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export async function runSource(source: string, options: {
  backend?: "default" | "llvm";
  asyncTest?: boolean;
  includes?: string[];
  variant?: "strict" | "sloppy";
  sanitize?: boolean;
  compileTimeoutMs?: number;
  runtimeTimeoutMs?: number;
  keep?: boolean;
  /** Measure what an island can measure (decision S4): sloppy variants only,
   * with the entry a tiny native module importing the adapted test, so the
   * pre-scan can island it. The entry module itself always stays native. */
  islands?: boolean;
  /** The exclusion the island lane lifted for this variant, when it lifted
   * one. `host:script-environment` selects the script adaptation below. */
  liftedReason?: string;
} = {}): Promise<Outcome> {
  // Keep sources OUTSIDE node_modules: scriptc intentionally treats imports
  // under that directory as package code, with different compilation rules.
  const workDir = mkdtempSync(join(tmpdir(), "scriptc-test262-"));
  // The island lane keeps `main.cjs` as the adapted test module and adds a
  // native entry that imports it: prepare() and the parse-negative matching
  // both name the test module, and an island entry is not a program shape.
  const islandLane = options.islands === true && options.variant === "sloppy";
  const entry = join(workDir, islandLane ? "entry.ts" : options.variant === "sloppy" ? "main.cjs" : "main.js");
  const testModule = islandLane ? join(workDir, "main.cjs") : entry;
  const binary = join(workDir, process.platform === "win32" ? "program.exe" : "program");
  const resultFile = join(workDir, "compile.json");
  const requestFile = join(workDir, "request.json");
  let phase = "compile";
  try {
    const marker = `${completion}:${randomBytes(16).toString("hex")}`;
    // A lifted script-environment variant keeps the script shape: top-level
    // `this` and `var` must be global, so the island replays the body as a
    // script instead of loading it as a CommonJS module.
    const script = islandLane && !(options.asyncTest ?? false) &&
      options.liftedReason === "host:script-environment" && scriptEnvironment(source);
    const text = islandLane
      ? prepareIsland(source, options.asyncTest ?? false, marker, options.includes, script)
      : prepare(source, options.asyncTest ?? false, marker, options.variant, options.includes);
    writeFileSync(testModule, text);
    // Evaluate the harness first: its shared bindings must be initialized
    // before the island requires them, or the loader has to hold their
    // temporal dead zone through the island's own require (a sync cycle).
    if (islandLane) writeFileSync(entry, 'import "./harness.ts";\nimport "./main.cjs";\n');
    writeFileSync(join(workDir, "harness.ts"), harnessSource.replace(completion, marker));
    writeFileSync(join(workDir, "assert-throws.js"), assertThrowsSource);
    writeFileSync(requestFile, JSON.stringify({
      entry, binary, workDir, result: resultFile,
      backend: options.backend ?? "default", sanitize: options.sanitize ?? false,
      islands: islandLane,
    }));
    const compiled = await boundedRun(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./compile-worker.ts", import.meta.url)), requestFile,
    ], options.compileTimeoutMs ?? 120_000);
    const finish = (outcome: Outcome): Outcome => ({ ...outcome, ...(options.keep ? { workDir } : {}) });
    if (compiled.timeout) return finish({ status: "timeout", phase });
    if (compiled.signal) return finish({ status: "crash", phase, reason: compiled.signal, stderr: compiled.stderr });
    if (compiled.code !== 0 || compiled.overflow) {
      return finish({ status: "build-error", phase, stdout: compiled.stdout, stderr: compiled.stderr, reason: compiled.signal ?? "compiler process failed" });
    }
    const build = JSON.parse(readFileSync(resultFile, "utf8"));
    if (!build.ok) {
      return finish({ status: compileFailureStatus(build.diagnostics), phase, diagnostics: build.diagnostics });
    }
    // The build reports the modules it ran in islands, cache hits included.
    // A variant whose test module is one of them reports its own outcome:
    // the verdict is Node's, so it can never count as a native pass.
    const island = islandLane && Array.isArray(build.islands?.modules) &&
      build.islands.modules.some((file) => sameFile(file, testModule));
    phase = "runtime";
    const result = await boundedRun(binary, [], options.runtimeTimeoutMs ?? 10_000);
    const common = { backend: build.backend, ...(island ? { island: true as const } : {}) };
    const report = (outcome: Outcome): Outcome => island
      ? { ...outcome, status: outcome.status === "pass" ? "island-pass" : "island-fail" }
      : outcome;
    if (result.timeout) return finish(report({ ...common, status: "timeout", phase }));
    if (result.signal) return finish(report({ ...common, status: "crash", phase, reason: result.signal, stderr: result.stderr }));
    const stderr = options.sanitize
      ? result.stderr.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "")
      : result.stderr;
    if (result.code === 86 && stderr === "SCRIPTC_TEST262_HARNESS: reference equality requires an identity-preserving adapter\n") {
      return finish(report({ ...common, status: "harness-refusal", phase, reason: "reference-assertion", stderr }));
    }
    if (result.code === 86 && stderr === "SCRIPTC_TEST262_HARNESS: assert.throws needs an Error instance\n") {
      return finish(report({ ...common, status: "harness-refusal", phase, reason: "non-error-assertion", stderr }));
    }
    if (result.code === 0 && !result.overflow && stderr === "" && result.stdout === `${marker}\n`) {
      return finish(report({ ...common, status: "pass" }));
    }
    // Require the entire diagnostic, so a sanitizer report following a known
    // refusal cannot be hidden by the regression expectation.
    const fence = /^Uncaught Error: [^\n]+\[(SC\d{4}) at ([^\n]+):\d+\]\n$/.exec(stderr);
    return finish(report({
      ...common,
      status: fence ? (fence[2]!.endsWith("/harness.ts") ? "harness-refusal" : "runtime-refusal") : "fail",
      phase, reason: fence?.[1] ?? `exit ${result.code}; completion marker required`,
      stdout: result.stdout, stderr,
    }));
  } catch (error) {
    return { status: "runner-error", phase, reason: String(error), ...(options.keep ? { workDir } : {}) };
  } finally {
    if (!options.keep) await rm(workDir, { recursive: true, force: true });
  }
}
