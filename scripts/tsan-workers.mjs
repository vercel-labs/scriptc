#!/usr/bin/env node
// Builds every corpus program that uses worker threads with ThreadSanitizer and runs it. A data race that
// tests/harness/tsan.supp does not name fails the run.
//
// Usage: node scripts/tsan-workers.mjs [--pattern=<regex over program paths>] [--jobs=4] [--out=<dir>] [--list]
//
// `scriptc build --sanitize` is AddressSanitizer. This script puts a `clang` first on PATH that turns the same
// build into a ThreadSanitizer one: it replaces -fsanitize=address with -fsanitize=thread, and in the program's
// LLVM IR, whose functions carry `sanitize_address`, it writes `sanitize_thread`, so generated code is
// instrumented as well as the runtime. The runtime compiles from source under it with no change. Such a build is
// never cached (the compiler caches only for a direct clang driver), so each program costs a full sanitized
// build: about 50 s on 4 cores.
//
// The lane judges races only. A program's output and exit status are the differential suite's business; here a
// program fails when ThreadSanitizer reports, when it dies of a signal, or when it runs out of time.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { programDefines } from "../tests/harness/define-directive.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = join(root, "tests", "corpus");
const suppressions = join(root, "tests", "harness", "tsan.supp");
/** The exit status ThreadSanitizer gives a process that reported a race. */
const raceStatus = 66;

/** The directive head of a corpus program: its first two lines, the same head the differential harness reads.
 * @param {string} source
 * @returns {string[]} */
export function directiveHead(source) {
  return source.split("\n", 2);
}

/** Why the lane does not build this program, or null when it does. `host` defaults to this machine.
 * Intl forms need the Linux x64 ICU pack; other hosts refuse them (SC3002), so they are skipped there
 * the way the differential harness skips them. `// @exit` and the Node oracle flags do not change the
 * build or the compiled binary's environment, so the lane leaves them to the differential suite.
 * @param {string} source
 * @param {{ platform: string, arch: string }} [host]
 * @returns {string | null} */
export function skipReason(source, host = { platform: process.platform, arch: process.arch }) {
  const head = directiveHead(source);
  // A Node island program loads Node from a libnode pack, which is not built with ThreadSanitizer.
  if (head.some((line) => /^\/\/ @requires-libnode\s*$/.test(line))) {
    return "loads Node from a libnode pack, which is not built with ThreadSanitizer";
  }
  // WebAssembly traps (an out-of-bounds access, a stack overflow) arrive as signals unless the runtime is
  // built for AddressSanitizer, which checks explicitly (SCR_WASM_ASAN in scr_wasm.c). ThreadSanitizer's own
  // handler reports such a signal as fatal.
  if (/\bWebAssembly\b/.test(source)) {
    return "WebAssembly traps arrive as signals under ThreadSanitizer";
  }
  if (
    head.some((line) => /^\/\/ @requires-icu\s*$/.test(line)) &&
    !(host.platform === "linux" && host.arch === "x64")
  ) {
    return "Intl forms need the Linux x64 ICU runtime pack; other hosts refuse them (SC3002)";
  }
  return null;
}

/** Extra `scriptc build` arguments the differential harness would pass for this program: `// @define`
 * lines become `--define=process.env.NAME=<json>`, and `// @optimization: speed` selects that posture.
 * @param {string} source
 * @returns {string[]} */
export function buildArguments(source) {
  const head = directiveHead(source);
  /** @type {string[]} */
  const args = [];
  if (head.some((line) => /^\/\/ @optimization:\s*speed\s*$/.test(line))) {
    args.push("--optimization=speed");
  }
  const defines = programDefines(head);
  if (defines !== null) {
    for (const [key, value] of Object.entries(defines.define)) {
      args.push(`--define=${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}

/** Environment for running a compiled worker binary: the differential harness's `SCRIPTC_TEST_ENV`,
 * any `// @env: NAME=VALUE[,NAME=VALUE]` pairs from the directive head, and the lane's `TSAN_OPTIONS`.
 * @param {string} source
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv} */
export function runEnvironment(source, base = process.env) {
  /** @type {Record<string, string>} */
  const directiveEnv = {};
  for (const line of directiveHead(source)) {
    const m = /^\/\/ @env:\s*(.+?)\s*$/.exec(line);
    if (m === null) continue;
    for (const pair of m[1].split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) directiveEnv[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return {
    ...base,
    SCRIPTC_TEST_ENV: "from-harness",
    ...directiveEnv,
    TSAN_OPTIONS: `suppressions=${suppressions}:halt_on_error=0:exitcode=${raceStatus}:print_suppressions=0`,
  };
}

/** Corpus programs that import worker_threads and need nothing this lane does not provide.
 * @returns {string[]} */
export function workerPrograms() {
  /** @type {string[]} */
  const programs = [];
  for (const entry of readdirSync(corpus).sort()) {
    const path = join(corpus, entry);
    const file = statSync(path).isDirectory() ? join(path, "main.ts") : path;
    if (!file.endsWith(".ts") || !existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!/["'](?:node:)?worker_threads["']/.test(source)) continue;
    if (skipReason(source) !== null) continue;
    programs.push(file);
  }
  return programs;
}

/** The text of the `clang` that stands in front of the real one.
 * @param {string} real
 * @returns {string} */
export function shimSource(real) {
  return `#!/bin/sh
# Written by scripts/tsan-workers.mjs: the sanitized build's clang, with ThreadSanitizer for AddressSanitizer.
copies=""
n=0
for a in "$@"; do
  n=$((n + 1))
  case "$a" in
    -fsanitize=address) a=-fsanitize=thread ;;
    *.ll)
      if [ -f "$a" ] && grep -q sanitize_address "$a"; then
        copy="\${TMPDIR:-/tmp}/scriptc-tsan-$$-$n.ll"
        sed 's/sanitize_address/sanitize_thread/g' "$a" > "$copy"
        copies="$copies $copy"
        a=$copy
      fi ;;
  esac
  set -- "$@" "$a"
  shift
done
"${real}" "$@"
status=$?
[ -n "$copies" ] && rm -f $copies
exit $status
`;
}

function toolchain(out) {
  const directory = join(out, "toolchain");
  const real = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && resolve(entry) !== directory)
    .map((entry) => join(entry, "clang"))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (real === undefined) throw new Error("clang is not on PATH; sanitized builds need it");
  mkdirSync(directory, { recursive: true });
  const shim = join(directory, "clang");
  writeFileSync(shim, shimSource(real));
  chmodSync(shim, 0o755);
  return directory;
}

function run(command, args, { env, timeout }) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-262144);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ status: null, signal: null, timedOut, stderr: String(error) });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, timedOut, stderr });
    });
  });
}

/** What a finished run means: null when it is fine, otherwise the reason it fails.
 * @param {{ status: number | null, signal: string | null, timedOut: boolean, stderr: string }} result
 * @returns {string | null} */
export function verdict({ status, signal, timedOut, stderr }) {
  if (timedOut) return "ran out of time";
  if (stderr.includes("WARNING: ThreadSanitizer") || status === raceStatus) {
    const summaries = [...stderr.matchAll(/^SUMMARY: ThreadSanitizer: (.*)$/gm)].map(
      (match) => match[1],
    );
    return `ThreadSanitizer: ${[...new Set(summaries)].join("; ") || "report"}`;
  }
  if (signal !== null) return `killed by ${signal}`;
  return null;
}

async function main() {
  const options = {
    pattern: null,
    jobs: Math.min(4, availableParallelism()),
    out: null,
    list: false,
  };
  for (const argument of process.argv.slice(2)) {
    const [name, value] = argument.split(/=(.*)/s);
    if (name === "--pattern") options.pattern = new RegExp(value);
    else if (name === "--jobs") options.jobs = Math.max(1, Number(value));
    else if (name === "--out") options.out = resolve(value);
    else if (name === "--list") options.list = true;
    else throw new Error(`unknown option ${argument}`);
  }
  const out = options.out ?? join(root, "node_modules", ".cache", "scriptc-tsan");
  const programs = workerPrograms().filter(
    (program) => options.pattern === null || options.pattern.test(relative(root, program)),
  );
  if (options.list) {
    for (const program of programs) console.log(relative(root, program));
    return 0;
  }
  mkdirSync(out, { recursive: true });
  const buildEnv = { ...process.env, PATH: `${toolchain(out)}${delimiter}${process.env.PATH}` };
  const failures = [];
  const queue = programs.map((program, index) => ({ program, index }));
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const name = relative(root, item.program);
      const binary = join(out, `program-${item.index}`);
      const source = readFileSync(item.program, "utf8");
      const build = await run(
        process.execPath,
        [
          join(root, "packages", "cli", "dist", "main.js"),
          "build",
          item.program,
          ...buildArguments(source),
          "--sanitize",
          "-o",
          binary,
        ],
        { env: buildEnv, timeout: 900_000 },
      );
      let reason = build.status === 0 ? null : `build failed\n${build.stderr.slice(-4000)}`;
      if (reason === null) {
        const result = await run(binary, [], { env: runEnvironment(source), timeout: 300_000 });
        reason = verdict(result);
        if (reason !== null) reason += `\n${result.stderr.slice(-8000)}`;
        rmSync(binary, { force: true });
      }
      if (reason === null) console.log(`ok    ${name}`);
      else {
        console.log(`FAIL  ${name}: ${reason.split("\n")[0]}`);
        failures.push({ name, reason });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, queue.length) }, worker));
  for (const failure of failures) console.error(`\n== ${failure.name}\n${failure.reason}`);
  console.log(`\n${programs.length - failures.length} of ${programs.length} worker programs clean`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
