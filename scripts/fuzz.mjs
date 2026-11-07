#!/usr/bin/env node
// Builds the fuzz program (tests/fuzz/main.ts) with AddressSanitizer, the reference-count audit and
// UndefinedBehaviorSanitizer, replays each target's regression cases, then fuzzes each target for a fixed time.
// tests/fuzz/README.md describes the targets, the case files and how to reproduce a failure.
//
// Usage: node scripts/fuzz.mjs [options]
//   --targets=json,url   the targets to run (default: all)
//   --seconds=10         fuzzing time per target; 0 replays the regressions only
//   --seed=1             the first seed; each run of a target takes the next one
//   --iterations=20000   generated cases per run of an in-process target
//   --jobs=4             targets fuzzed at once
//   --out=<dir>          the executable, logs and failing cases (default node_modules/.cache/scriptc-fuzz)
//   --framing=<seconds>  also run the request-framing differential against Node for that long
//   --no-build           reuse the executable in --out
//   --list               print the target names
//
// Exit status: 0 when every target built, replayed and fuzzed without a failure; 1 otherwise. A failure writes
// the case that was running to <out>/crashes/, ready to copy into tests/fuzz/regressions/<target>/.
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
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, requestCase, responseCase, responseServer, sendRequest } from "./fuzz-http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fuzzDirectory = join(root, "tests", "fuzz");

const program = join(fuzzDirectory, "main.ts");

/**
 * Every target of the fuzz program. `process` targets generate and run their cases inside the program; `server`
 * and `client` are its HTTP server and client, which this script drives over sockets.
 * tests/harness/fuzz-targets.test.ts keeps this table, the program and the case directories in step.
 */
export const targets = [
  { name: "bytes", kind: "process" },
  { name: "json", kind: "process" },
  { name: "number", kind: "process" },
  { name: "path", kind: "process" },
  { name: "regex", kind: "process" },
  { name: "url", kind: "process" },
  { name: "zlib", kind: "process" },
  { name: "http-server", kind: "server" },
  { name: "http-client", kind: "client" },
];

/**
 * Flags the sanitized build gets beside `--sanitize`, which is AddressSanitizer and the reference-count audit.
 * A failed check ends the run. One check is off: the runtime and the vendored regular expression engine call
 * memcpy and memset with a null pointer and a length of zero (scr_inspect.c, libregexp.c), which the C standard
 * leaves undefined and every libc this project targets treats as doing nothing.
 */
export const undefinedBehaviorFlags = [
  "-fsanitize=undefined",
  "-fno-sanitize=nonnull-attribute",
  "-fno-sanitize-recover=undefined",
];

function parseArguments(argv) {
  const options = {
    targets: targets.map((target) => target.name),
    seconds: 10,
    seed: 1,
    iterations: 20000,
    jobs: Math.min(4, availableParallelism()),
    out: join(root, "node_modules", ".cache", "scriptc-fuzz"),
    framing: 0,
    build: true,
    list: false,
  };
  for (const argument of argv) {
    const [name, value] = argument.split(/=(.*)/s);
    if (name === "--targets") options.targets = value.split(",").filter(Boolean);
    else if (name === "--seconds") options.seconds = Number(value);
    else if (name === "--seed") options.seed = Number(value);
    else if (name === "--iterations") options.iterations = Number(value);
    else if (name === "--jobs") options.jobs = Math.max(1, Number(value));
    else if (name === "--out") options.out = resolve(value);
    else if (name === "--framing") options.framing = Number(value);
    else if (name === "--no-build") options.build = false;
    else if (name === "--list") options.list = true;
    else throw new Error(`unknown option ${argument}`);
  }
  for (const key of ["seconds", "seed", "iterations", "jobs", "framing"])
    if (!Number.isFinite(options[key]) || options[key] < 0)
      throw new Error(`--${key} needs a number`);
  const known = new Set(targets.map((target) => target.name));
  for (const name of options.targets) if (!known.has(name)) throw new Error(`no target ${name}`);
  return options;
}

/** Run a command; resolve with its exit status, signal, stdout and the tail of its stderr. */
function run(command, args, { env = process.env, timeout = 0, onStderrLine } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout)
        : null;
    child.stdout.on("data", (data) => {
      stdout = (stdout + data).slice(-65536);
    });
    child.stderr.on("data", (data) => {
      const text = String(data);
      stderr = (stderr + text).slice(-65536);
      if (onStderrLine === undefined) return;
      const lines = (partial + text).split("\n");
      partial = lines.pop();
      for (const line of lines) onStderrLine(line);
    });
    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      done({ ok: false, status: null, signal: null, timedOut, stdout, stderr: String(error) });
    });
    child.on("close", (status, signal) => {
      if (timer !== null) clearTimeout(timer);
      done({ ok: status === 0 && !timedOut, status, signal, timedOut, stdout, stderr });
    });
  });
}

function describe(result) {
  if (result.timedOut) return "timed out";
  if (result.signal !== null) return `killed by ${result.signal}`;
  return `exit status ${result.status}`;
}

function caseFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));
}
const readCase = (path) => JSON.parse(readFileSync(path, "utf8"));
const seedDirectory = (name) => join(fuzzDirectory, "seeds", name);
const regressionFiles = (name) => caseFiles(join(fuzzDirectory, "regressions", name));

/** A directory whose `clang` adds the undefined-behavior checks to every compile and link of the real one. */
function sanitizerToolchain(out) {
  const directory = join(out, "toolchain");
  const real = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && resolve(entry) !== directory)
    .map((entry) => join(entry, "clang"))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (real === undefined) throw new Error("clang is not on PATH; sanitized builds need it");
  mkdirSync(directory, { recursive: true });
  const shim = join(directory, "clang");
  writeFileSync(shim, `#!/bin/sh\nexec "${real}" "$@" ${undefinedBehaviorFlags.join(" ")}\n`);
  chmodSync(shim, 0o755);
  return directory;
}

async function pool(items, jobs, work) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  });
  await Promise.all(runners);
}

class Session {
  constructor(options) {
    this.options = options;
    this.binary = join(options.out, "bin", "fuzz");
    this.crashes = join(options.out, "crashes");
    this.failures = [];
    this.rows = [];
    // The runtime's reference-count audit reports leaks; LeakSanitizer stays off as in the test lanes.
    this.env = {
      ...process.env,
      ASAN_OPTIONS: process.env.ASAN_OPTIONS ?? "detect_leaks=0",
      UBSAN_OPTIONS: process.env.UBSAN_OPTIONS ?? "print_stacktrace=1",
    };
  }

  /** Record a failure; `cases` are written as files a developer can replay or commit as regressions. */
  fail(target, what, log, cases = []) {
    mkdirSync(this.crashes, { recursive: true });
    const stem = `${target}-${this.failures.length + 1}`;
    const files = cases.map((c, index) => {
      const file = join(this.crashes, `${stem}${cases.length > 1 ? `-${index + 1}` : ""}.json`);
      writeFileSync(file, JSON.stringify(c) + "\n");
      return file;
    });
    const logFile = join(this.crashes, `${stem}.log`);
    writeFileSync(logFile, `${what}\n\n${log}\n`);
    this.failures.push({ target, what, files, logFile });
    console.error(`\nFAIL ${target}: ${what}`);
    console.error(log.split("\n").slice(-40).join("\n"));
    for (const file of files) console.error(`  case: ${file}`);
  }

  /** One sanitized build of the whole program; every target is a subcommand of it. */
  async build() {
    const started = Date.now();
    const toolchain = sanitizerToolchain(this.options.out);
    const result = await run(
      process.execPath,
      [
        join(root, "packages", "cli", "dist", "main.js"),
        "build",
        program,
        "--sanitize",
        "-o",
        this.binary,
      ],
      { env: { ...this.env, PATH: `${toolchain}${delimiter}${process.env.PATH}` } },
    );
    if (!result.ok) this.fail("build", describe(result), result.stdout + result.stderr);
    else console.log(`built the fuzz program in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    return result.ok;
  }

  // In-process targets.

  async replayProcess(target, files) {
    const replay = (list) =>
      run(this.binary, [target.name, "replay", ...list], { env: this.env, timeout: 120_000 });
    const all = await replay(files);
    if (all.ok) return true;
    // Name the file: replay them one at a time.
    for (const file of files) {
      const one = await replay([file]);
      if (!one.ok) {
        this.fail(target.name, `regression ${file}: ${describe(one)}`, one.stderr);
        return false;
      }
    }
    this.fail(target.name, `regressions together: ${describe(all)}`, all.stderr);
    return false;
  }

  async fuzzProcess(target, deadline) {
    const { iterations } = this.options;
    const seeds = seedDirectory(target.name);
    let seed = this.options.seed;
    let cases = 0;
    while (Date.now() < deadline) {
      const args = [target.name, "fuzz", seeds, String(seed), "0", String(iterations)];
      const result = await run(this.binary, args, { env: this.env, timeout: 300_000 });
      if (!result.ok) {
        // The same run again, printing each case before it runs: the last one printed is the one that failed.
        let last = "";
        await run(this.binary, [...args, "v"], {
          env: this.env,
          timeout: 600_000,
          onStderrLine: (line) => {
            if (line.startsWith("[")) last = line;
          },
        });
        let failing = [];
        try {
          failing = [JSON.parse(last)];
        } catch {
          // No case line: the failure is not tied to one case (start-up, or the audit at exit).
        }
        this.fail(
          target.name,
          `seed ${seed}: ${describe(result)} (fuzz ${args.join(" ")})`,
          result.stderr,
          failing,
        );
        return cases;
      }
      cases += iterations;
      seed++;
    }
    return cases;
  }

  // The HTTP server target.

  async startServer(command, args) {
    const child = spawn(command, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    const server = { child, port: 0, stderr: "", lines: [], exited: null };
    let partial = "";
    child.stderr.on("data", (data) => {
      server.stderr = (server.stderr + data).slice(-65536);
    });
    server.listening = new Promise((ready) => {
      child.stdout.on("data", (data) => {
        const lines = (partial + data).split("\n");
        partial = lines.pop();
        for (const line of lines) {
          const match = /^listening (\d+)$/.exec(line);
          if (match !== null) {
            server.port = Number(match[1]);
            ready(true);
          } else server.lines.push(line);
        }
      });
      child.on("close", (status, signal) => {
        server.exited = { status, signal, timedOut: false };
        ready(false);
      });
      child.on("error", () => ready(false));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const ok = await server.listening;
    clearTimeout(timer);
    return ok ? server : null;
  }

  async fuzzServer(target, deadline, regressions) {
    const server = await this.startServer(this.binary, [target.name, "0"]);
    if (server === null) {
      this.fail(target.name, "the server did not start", "");
      return 0;
    }
    const seeds = caseFiles(seedDirectory(target.name)).map(readCase);
    const dead = async () => !(await alive(server.port)) && !(await alive(server.port));
    let cases = 0;
    let recent = [];
    try {
      for (const file of regressions) {
        await sendRequest(server.port, readCase(file), { idle: 200 });
        if (await dead()) {
          this.fail(target.name, `regression ${file}: the server stopped answering`, server.stderr);
          return cases;
        }
      }
      for (let index = 0; Date.now() < deadline;) {
        const batch = [];
        for (let k = 0; k < 16; k++) batch.push(requestCase(this.options.seed, index++, seeds));
        await Promise.all(batch.map((c) => sendRequest(server.port, c, { linger: 8 })));
        recent = [...recent.slice(-16), ...batch];
        if (await dead()) {
          const what = `seed ${this.options.seed}: the server stopped answering near request ${index}`;
          this.fail(target.name, what, server.stderr, recent);
          return cases;
        }
        cases += batch.length;
      }
    } finally {
      server.child.kill("SIGTERM");
    }
    return cases;
  }

  // The HTTP client target.

  async runClient(target, caseOf, first, count) {
    const responses = await responseServer(caseOf);
    try {
      const args = [target.name, String(responses.port), String(first), String(count)];
      const result = await run(this.binary, args, {
        env: this.env,
        // Each request settles within its own 500 ms timeout; this is for a client that stops making progress.
        timeout: 60_000 + count * 1000,
      });
      const settled = result.ok && result.stdout.includes(`settled ${count}\n`);
      return { settled, result, last: responses.last() };
    } finally {
      await responses.close();
    }
  }

  async fuzzClient(target, deadline, regressions) {
    // Each regression answers six requests in a row, so both http.get and fetch, with redirects followed and
    // not, see it.
    if (regressions.length > 0) {
      const cases = regressions.map(readCase);
      const run = await this.runClient(
        target,
        (index) => cases[Math.floor(index / 6)],
        0,
        6 * cases.length,
      );
      if (!run.settled) {
        const file = regressions[Math.floor(Math.max(run.last, 0) / 6)];
        const what = `regression ${file}: request ${run.last} did not settle (${describe(run.result)})`;
        this.fail(target.name, what, run.result.stdout + run.result.stderr);
        return 0;
      }
    }
    const seeds = caseFiles(seedDirectory(target.name)).map(readCase);
    const caseOf = (index) => responseCase(this.options.seed, index, seeds);
    const batch = 500;
    let cases = 0;
    while (Date.now() < deadline) {
      const run = await this.runClient(target, caseOf, cases, batch);
      if (!run.settled) {
        const what =
          `seed ${this.options.seed}: request ${run.last} did not settle (${describe(run.result)}); ` +
          `replay with fuzz http-client <port> ${run.last} 1 against scripts/fuzz-http.mjs serve <case>`;
        this.fail(target.name, what, run.result.stdout + run.result.stderr, [caseOf(run.last)]);
        return cases;
      }
      cases += batch;
    }
    return cases;
  }

  // The request-framing differential: the same bytes to the server under Node and to the compiled server.

  async framing(seconds) {
    const name = "http-server";
    const servers = [
      await this.startServer(process.execPath, [program, name, "0", "log"]),
      await this.startServer(this.binary, [name, "0", "log"]),
    ];
    if (servers.includes(null)) {
      for (const server of servers) server?.child.kill("SIGTERM");
      this.fail("framing", "a server did not start", "");
      return;
    }
    const seeds = caseFiles(seedDirectory(name)).map(readCase);
    const deadline = Date.now() + seconds * 1000;
    const counts = { cases: 0, agree: 0, stricter: 0, framing: 0 };
    const stricter = [];
    try {
      for (let index = 0, round = 0; Date.now() < deadline; round++) {
        const batch = [];
        for (let k = 0; k < 16; k++) batch.push(requestCase(this.options.seed, index++, seeds));
        const sent = await Promise.all(
          batch.map(async (c) => ({
            c,
            ports: await Promise.all(
              servers.map(async (server) => (await sendRequest(server.port, c)).localPort),
            ),
          })),
        );
        // A marker request on each server: once its line is in the log, every earlier line is too.
        const logs = await Promise.all(servers.map((server) => syncedLog(server, round)));
        if (logs.includes(null)) {
          const which = logs[0] === null ? "Node" : "the compiled server";
          this.fail(
            "framing",
            `${which} stopped answering`,
            servers[logs[0] === null ? 0 : 1].stderr,
          );
          return;
        }
        for (const { c, ports } of sent) {
          const [node, native] = ports.map((port, side) => requestsOf(logs[side], port));
          const verdict = compareRequests(node, native);
          counts.cases++;
          counts[verdict]++;
          if (verdict === "stricter" && stricter.length < 50) stricter.push({ c, node, native });
          if (verdict === "framing") {
            const what = "Node and the compiled server framed one byte stream differently";
            const log = `node:   ${JSON.stringify(node)}\nnative: ${JSON.stringify(native)}`;
            this.fail("framing", what, log, [c]);
          }
        }
      }
    } finally {
      for (const server of servers) server.child.kill("SIGTERM");
    }
    mkdirSync(this.options.out, { recursive: true });
    writeFileSync(
      join(this.options.out, "framing-stricter.json"),
      JSON.stringify(stricter, null, 1),
    );
    console.log(
      `framing: ${counts.cases} byte streams, ${counts.agree} framed alike, ${counts.stricter} where one ` +
        `server stopped earlier (first ${stricter.length} in framing-stricter.json), ${counts.framing} framed differently`,
    );
    this.rows.push({ target: "framing", cases: counts.cases, ok: counts.framing === 0 });
  }

  async main() {
    const { options } = this;
    const selected = targets.filter((target) => options.targets.includes(target.name));
    mkdirSync(dirname(this.binary), { recursive: true });
    rmSync(this.crashes, { recursive: true, force: true });
    if (options.build && !(await this.build())) return;
    await pool(selected, options.jobs, async (target) => {
      const regressions = regressionFiles(target.name);
      const started = Date.now();
      const deadline = started + options.seconds * 1000;
      const before = this.failures.length;
      let cases = 0;
      if (target.kind === "process") {
        if (regressions.length === 0 || (await this.replayProcess(target, regressions)))
          cases = await this.fuzzProcess(target, deadline);
      } else if (target.kind === "server")
        cases = await this.fuzzServer(target, deadline, regressions);
      else cases = await this.fuzzClient(target, deadline, regressions);
      this.rows.push({
        target: target.name,
        regressions: regressions.length,
        cases,
        seconds: (Date.now() - started) / 1000,
        ok: this.failures.length === before,
      });
    });
    if (options.framing > 0 && this.failures.length === 0) await this.framing(options.framing);
  }
}

/** The server's log lines so far, after a marker request has passed through it; null when it stops answering. */
async function syncedLog(server, round) {
  const marker = `/sync-${round}`;
  const seen = () =>
    server.lines.some((line) => line.includes(`"url":"${marker}"`) && line.includes('"body"'));
  await sendRequest(server.port, [
    "0",
    "0",
    `GET ${marker} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
  ]);
  for (let waited = 0; !seen(); waited += 10) {
    if (waited > 5000 || server.exited !== null) return null;
    await new Promise((next) => setTimeout(next, 10));
  }
  // The marker's own lines are dropped: its connection can reuse the port of one that has closed.
  return server.lines.splice(0).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.url === marker ? [] : [entry];
    } catch {
      return [];
    }
  });
}

/** The requests one connection delivered, in order: each head with its body, when the body ended. */
export function requestsOf(log, port) {
  const heads = [];
  const bodies = [];
  for (const entry of log) {
    if (entry.from !== port) continue;
    if (entry.method !== undefined) {
      heads.push(`${entry.method} ${entry.url} HTTP/${entry.version} ${entry.headers}`);
    } else bodies.push(`${entry.body}+${entry.trailers}`);
  }
  return heads.map((head, index) =>
    index < bodies.length ? `${head} body ${bodies[index]}` : head,
  );
}

/**
 * "agree" when both servers delivered the same requests; "stricter" when one stopped earlier than the other (it
 * delivered fewer requests, or its last request never finished its body); "framing" when both delivered a
 * request at the same position and the two differ, which is the disagreement request smuggling needs.
 */
export function compareRequests(a, b) {
  let stricter = a.length !== b.length;
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index++) {
    if (a[index] === b[index]) continue;
    const [short, long, list] =
      a[index].length < b[index].length ? [a[index], b[index], a] : [b[index], a[index], b];
    if (index !== list.length - 1 || !long.startsWith(short + " body ")) return "framing";
    stricter = true;
  }
  return stricter ? "stricter" : "agree";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    for (const target of targets) console.log(target.name);
    return 0;
  }
  const session = new Session(options);
  const started = Date.now();
  await session.main();
  console.log("");
  for (const row of session.rows.sort((a, b) => a.target.localeCompare(b.target))) {
    const detail =
      row.regressions === undefined
        ? ""
        : `${row.regressions} regressions, ${row.seconds.toFixed(1)} s`;
    console.log(
      `${row.ok ? "ok  " : "FAIL"} ${row.target.padEnd(12)} ${String(row.cases).padStart(9)} cases  ${detail}`,
    );
  }
  mkdirSync(options.out, { recursive: true });
  writeFileSync(
    join(options.out, "summary.json"),
    JSON.stringify({ seed: options.seed, rows: session.rows, failures: session.failures }, null, 1),
  );
  console.log(`\n${((Date.now() - started) / 1000).toFixed(0)} s in total`);
  if (session.failures.length === 0) return 0;
  console.error(
    `\n${session.failures.length} failure(s). tests/fuzz/README.md says how to replay a case file; to keep one ` +
      "as a test, copy it into tests/fuzz/regressions/<target>/.",
  );
  return 1;
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
