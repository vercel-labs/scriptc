/* The Windows differential lane — env-gated (SCRIPTC_WIN=1), skipped
 * everywhere else so the macOS lanes never see it. The workflow: corpus
 * programs are CROSS-COMPILED on the host via `zig cc` (SCRIPTC_CC=zigcc,
 * SCRIPTC_TARGET=x86_64-windows-gnu), the .exe and the program source ship
 * to the Windows box over scp, and both sides run THERE over ssh — the
 * binary, and the box's own WINDOWS Node as the oracle (Node on Windows is
 * what a Windows user would compare against; the box pins the same
 * .node-version as the macOS lanes). Same contract as differential.test.ts:
 * stdout byte-equal, stderr byte-equal for exit-0 programs, exit codes
 * agree with the `// @exit:` directive. NOTHING is normalized — a CRLF or
 * path-separator difference is a finding, not noise.
 *
 * Scope: the whole corpus — `// @dynamic` programs included (the engine
 * archive cross-builds per target, buildEngineArchiveCross) and zlib too
 * (per-target vendored objects) — PLUS the listening-fixture legs
 * (tests/fixtures/{server,dgram,fetch}, the linux lane's shape): fixture
 * programs cross-compile, ship, and run ON THE BOX against the box's
 * Node, with the per-case driver script (the box's node again) following
 * the PORT protocol over a second ssh session — three legs compared
 * byte-exactly (fixture stdout, exit code, driver stdout), loopback
 * only. The fixture trees ship whole (the tls certs and drivers resolve
 * relative paths), so cwd on the box is the lane dir for every leg. The
 * FETCH fixture leg joins them (the linux lane's shape): the fixture
 * servers run under the box's Node for the whole describe and every case
 * runs both lanes on the box — the native fetch has no win32 gate left.
 * One visible skip class remains:
 * WINDOWS_SKIPS below names the programs whose
 * Node-on-Windows behavior the runtime deliberately does not reproduce,
 * each with its cause (posix-shaped spawn programs, uid/tty surfaces).
 * The skip lists ARE the remaining-phases worklist.
 *
 * Box etiquette (shared machine): everything lives in ONE directory
 * (C:/Users/rdp/work/scriptc-lane, recreated per run, deleted at the end),
 * a machine-wide advisory lock keeps two lane runs from stampeding the
 * box, and ssh connection multiplexing (ControlMaster) keeps the ~3 remote
 * ops per program cheap. SCRIPTC_WIN_FILTER=<regex> narrows a run for
 * triage; SCRIPTC_WIN_HOST overrides the ssh host alias (default
 * windows-dev). */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const enabled = process.env["SCRIPTC_WIN"] === "1";

const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const target = process.env["SCRIPTC_WIN_TARGET"] ?? "x86_64-windows-gnu";
const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
const laneDirWin = "C:\\Users\\rdp\\work\\scriptc-lane"; // remote commands (cmd.exe)
const laneDirScp = "C:/Users/rdp/work/scriptc-lane"; // scp destinations

/* ssh connection multiplexing: one master connection per run, every scp/ssh
 * rides it (~0.1s per op instead of ~0.4s). The control socket lives in the
 * OS tmpdir and dies with the run (ControlPersist=yes + explicit -O exit). */
const controlPath = join(tmpdir(), `scriptc-win-lane-${process.pid}.sock`);
const sshOpts = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${controlPath}`,
  "-o", "ControlPersist=yes",
  "-o", "ConnectTimeout=15",
];

/* Programs whose Node-on-Windows behavior the runtime deliberately does
 * not reproduce yet — the reason is the inventory entry. Compile-time
 * cross gates (events/net/...) skip themselves; this list covers what
 * COMPILES but diverges at runtime by design. */
const WINDOWS_SKIPS: Record<string, string> = {
  // child_process is REAL on win32 now (CreateProcessW + libuv's
  // quote_cmd_arg + handle-inheritance stdio; 1644-1646 are this lane's
  // platform-neutral coverage, spawning `node` — verified byte-exact
  // against Windows Node). What remains skipped here is POSIX-SHAPED
  // programs: their /bin/sh, sh, printf, cat, ln, true spawns are ENOENT
  // on Windows NODE too, so both sides fail the same way but render
  // differently — Node prints a stack for uncaught/unhandled errors
  // where the runtime prints one line, and @exit can't say "0 on posix,
  // 1 on win32". A second recurring class: a FAILED spawn's captured
  // stdout/stderr read "" here where Node types them null (the
  // documented spawnSync stance) — invisible on POSIX lanes where these
  // spawns succeed, exposed here where every one fails.
  "1360-spawn-sync.ts": "posix-shaped: every spawn is ENOENT on Windows Node too, exposing the documented spawn-failure \"\"-vs-null stdout stance (1644 covers spawnSync here)",
  "1361-spawn-events.ts": "posix-shaped: the unlistened /bin/sh spawn failure crashes both sides, rendered differently (1646 covers spawn events here)",
  "1362-spawn-timers.ts": "posix-shaped: the unlistened /bin/sh spawn failure crashes both sides, rendered differently",
  "1462-exec-sync.ts": "posix-shaped: the uncaught printf ENOENT throw crashes both sides, rendered differently (1645 covers exec here)",
  "1466-child-containers.ts": "posix-shaped: `true` is ENOENT on Windows Node too; the paths after the failed spawn diverge in rendering",
  "1470-child-lifecycle.ts": "posix-shaped: kill() on the spawn-failed child crashes Windows Node (unhandled 'error'); the runtime answers false",
  "1471-child-unref.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  "1473-promisify-execfile.ts": "posix-shaped: the unhandled spawn-ENOENT rejection crashes both sides, rendered differently",
  "1482-spawnsync-error.ts": "posix-shaped: /bin/sh fails ENOENT on Windows Node too — its null stdout .trim() crashes the oracle where the documented \"\" stance carries on",
  "1522-spawnsync-options.ts": "posix-shaped: the sh capture case exposes the documented spawn-failure \"\"-vs-null stance (every other line agrees; 1644 covers the options here)",
  "1523-spawn-options.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  "1525-child-exit-signal.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently (1646 covers kill/exit signals here)",
  "1535-spawn-fd-stdio.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  "1537-os-release-spawnsync-stdio.ts": "posix-shaped: the failed spawns expose the documented spawn-failure \"\"-vs-null stance",
  "1552-exec-options-record.ts": "posix-shaped: the uncaught /bin/echo ENOENT throw crashes both sides, rendered differently",
  "1562-spawn-conditional-spread.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  "1565-spawn-pipe-streams.ts": "posix-shaped: the unlistened /bin/sh spawn failure crashes both sides, rendered differently (1646 covers pipe streams here)",
  "1566-child-duck-interface.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  "1570-child-unref-kill-reffed.ts": "posix-shaped: the unlistened sleep spawn failure crashes both sides, rendered differently",
  "1573-promisify-execfile-env-spread.ts": "posix-shaped: the unhandled spawn-ENOENT rejection crashes both sides, rendered differently",
  "1578-exec-input-optional.ts": "posix-shaped: the uncaught cat ENOENT throw crashes both sides, rendered differently (1645 covers input here)",
  "1580-exec-env-conditional-spread.ts": "posix-shaped: the uncaught sh ENOENT throw crashes both sides, rendered differently (1645 covers env here)",
  "1464-env-writes.ts": "posix-shaped: the observing child is ENOENT on Windows, exposing the documented spawn-failure \"\"-vs-null stance",
  // Two programs the events unit's win32 arm surfaced (they compiled for
  // the first time once the events gate lifted): both drive their signal
  // listeners through a /bin/sh child, ENOENT on Windows Node too.
  "1443-signal-handlers.ts": "posix-shaped: the /bin/sh signal driver is ENOENT on Windows Node too — no portable way to deliver a real SIGINT to both sides here",
  "1469-remove-listener.ts": "posix-shaped: the unlistened sh spawn failure crashes both sides, rendered differently",
  // Not child_process: a posix-shaped fs program from another lane.
  // (The former POSIX-path-semantics skips are gone: a win32 target now
  // binds path/path.sep/path.delimiter/os.EOL and the file-URL bridge to
  // Node-on-Windows semantics — scr_path.c's path.win32 port and
  // scr_url.c's drive arm, selected at compile time by the triple.)
  // 1356 is a POSIX-SHAPED PROGRAM, not a runtime gap: its first line
  // (fileURLToPath("file:///tmp/...")) throws "File URL path must be
  // absolute" on Windows NODE too. Binary and Node crash with the SAME
  // TypeError, but Node prints a source excerpt + stack for uncaught
  // errors where the runtime prints one line, and @exit can't say "0 on
  // posix, 1 on win32". 1611-url-file-bridge-neutral.ts covers the
  // bridge on this lane.
  "1356-url-file-bridge.ts": "posix-shaped: file:///tmp URLs crash Windows Node too (1611 covers the bridge here)",
  "1612-cjs-module-globals.cjs": "__dirname/__filename are baked at compile time, so a cross-compiled binary carries build-host paths while the box's Node reports its staged directory; same-host lanes (macOS, the Linux mount) see identical paths on both sides",
  // uid/gid surfaces: no Windows arm exists in Node either (the members
  // are absent there); the runtime throws the same TypeError, but the
  // ORACLE differs per box user anyway.
  "1461-process-pid-getuid-kill.ts": "process.getuid absent on Windows (Node too)",
  "1531-process-arch-versions.ts": "process.getuid/getgid absent on Windows Node (typed present here)",
  "1571-optional-call-tostring-tail.ts": "process.getuid?.() short-circuits on Windows Node (member exists here)",
  // The errno-spelling gap 1520 used to name is FIXED (scr_fs_throw
  // translates the CRT's EACCES to EPERM on win32 — libuv's
  // ERROR_ACCESS_DENIED map; the program's caught branches print
  // matching codes on both sides now), but the program itself is
  // posix-shaped: its "mode does NOT re-apply to an existing file" line
  // is a POSIX truth — Windows Node re-applies the readonly bit and its
  // next unguarded accessSync(W_OK) crashes BOTH sides identically at
  // the same line, rendered differently (stack vs one line), where
  // @exit says 0.
  "1520-fs-wider-surface.ts": "posix-shaped: writeFileSync {mode} re-applies readonly on Windows (Node too) — the unguarded accessSync crashes both sides, rendered differently",
  // (1480 left this list: GetAdaptersAddresses walks libuv's exact rows.)
  // os.userInfo: shell is null on Windows Node; the scriptc surface types
  // it string ("" here) — and username/homedir differ per box anyway.
  "1540-os-userinfo.ts": "userInfo().shell null on Windows Node (typed string here)",
};

// The lane attempts the WHOLE corpus — `// @dynamic` programs included
// (the engine archive cross-builds for the windows triple). Still-gated
// features and WINDOWS_SKIPS skip visibly below.
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

/** `// @dynamic` (differential.test.ts's directive): compile with the
 * island engine embedded. The Node side needs no flag — the island shim
 * covers the surface. */
function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

/** `// @transform-types` (differential.test.ts's directive): the Node
 * oracle needs --experimental-transform-types for non-erasable syntax
 * (namespaces). Enum-declaring programs ride the same flag without a
 * directive — differential.test.ts's exact rule, mirrored so the two
 * lanes hand the oracle identical argv. */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators` (differential.test.ts's directive): Node cannot
 * execute decorators at all (V8 has not shipped the proposal), so the
 * oracle runs tsc's deterministic ES2022 downlevel of the program —
 * materialized beside the binary cache and SHIPPED to the box in the
 * entry's place. Single-file programs only, like the macOS lane. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

/** The downleveled oracle entry's box-side name: unique per program, and
 * .mjs so the box's module detection cannot re-guess. */
function decOracleName(file: string): string {
  return `${laneName(file)}.dec-oracle.mjs`;
}

/** Materializes the decorator downlevel under the test cache (a pure
 * function of the program bytes and the typescript version) and answers
 * the local path to ship. */
function decOraclePath(file: string): string {
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256").update(ts5.version).update("\0").update(src).digest("hex").slice(0, 16);
  const dir = join(cacheDir, "win-dec-oracle", key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, decOracleName(file));
  // Atomic publish: a concurrent run writes this same content-keyed path;
  // rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

const filter = process.env["SCRIPTC_WIN_FILTER"];
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = enabled
  ? ENTRY_EXTS.flatMap((ext) => [
      ...globSync(join(corpusDir, `*.${ext}`)),
      ...globSync(join(corpusDir, `*/main.${ext}`)),
    ])
      .sort()
      .filter((f) => filter === undefined || new RegExp(filter).test(f))
  : [];

if (enabled) {
  // compileC reads these at call time; this file runs in its own worker
  // process, so the macOS lanes never see them.
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = target;
}
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** The program's lane name: the corpus file's own name, or the directory's
 * for main.ts programs — unique within the corpus, and the .exe's name. */
function laneName(file: string): string {
  const rel = file.slice(corpusDir.length + 1);
  return /\/main\.(ts|js|mjs|cjs)$/.test(rel) ? rel.slice(0, rel.indexOf("/")) : rel;
}

/** Runs one command ON THE BOX via ssh (remote shell is cmd.exe), stdin
 * ended immediately (differential.test.ts's contract), cwd = the lane dir,
 * the harness env marker set for the child. */
async function runOnBox(remoteCmd: string, env?: Record<string, string>): Promise<RunResult> {
  const sets = Object.entries(env ?? {})
    .map(([k, v]) => `set ${k}=${v}&& `)
    .join("");
  const full = `cd /d ${laneDirWin} && set SCRIPTC_TEST_ENV=from-harness&& ${sets}${remoteCmd}`;
  const pending = execFileAsync("ssh", [...sshOpts, host, full], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  pending.child.stdin?.end();
  try {
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
      throw err;
    }
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

async function scpToLane(paths: string[]): Promise<void> {
  await execFileAsync("scp", ["-q", "-r", ...sshOpts, ...paths, `${host}:${laneDirScp}/`]);
}

/** The box's Node over the program shipped beside the binary — the same
 * shims the macOS oracle uses, shipped once in beforeAll. Windows Node
 * type-strips .ts natively (same pinned version as the macOS lanes). */
async function runWindowsNode(file: string): Promise<RunResult> {
  const name = laneName(file);
  const entry = wantsTscDecorators(file)
    ? decOracleName(file)
    : name === basename(file)
      ? name
      : `${name}\\${basename(file)}`;
  const transform = wantsTransformTypes(file)
    ? "--experimental-transform-types --disable-warning=ExperimentalWarning "
    : "";
  const nodep = directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l))
    ? "--no-deprecation "
    : "";
  return runOnBox(
    `node ${transform}${nodep}--import ./comptime-shim.mjs --import ./island-shim.mjs ${entry}`,
  );
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

async function crossCompile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash.update("windows\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${laneName(file)}.exe`);
  // Pinned "c" here and at every compile below: the Windows lane is a
  // C-reference suite — the cross-compile story is the C backend's.
  const result = await compile(file, { outPath, outDir, dynamic: wantsDynamic(file), backend: "c" });
  if (!result.ok) {
    throw new Error(
      "corpus program failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

/** Cross-compiles and ships one program: the .exe and the program's own
 * sources (the oracle's input) in ONE scp — directory programs ship whole
 * (tsconfig and siblings ride along), single files ship as themselves.
 * MUST complete before either side runs: the oracle reads the shipped
 * sources. */
async function shipProgram(file: string): Promise<void> {
  const binary = await crossCompile(file);
  const programRoot = /\/main\.(ts|js|mjs|cjs)$/.test(file) ? join(file, "..") : file;
  // Decorator programs additionally ship the tsc downlevel the oracle
  // executes (the compiler still eats the real source above).
  const oracleExtra = wantsTscDecorators(file) ? [decOraclePath(file)] : [];
  await scpToLane([binary, programRoot, ...oracleExtra]);
}

/* ── the LISTENING-fixture legs (tests/fixtures/server, tests/fixtures/dgram)
 * — server.test.ts's three-legged contract with every process ON THE BOX:
 * the fixture program (the box's Node lane and the cross-compiled .exe),
 * and the per-case driver script (the box's node) that talks to it over
 * the PORT protocol (`PORT <n>` on stderr; stderr is never compared, so
 * ephemeral ports stay out of every compared stream). Loopback only: the
 * fixtures pin 127.0.0.1 and the driver runs on the same box. The
 * fixture trees ship whole under the lane dir (beforeAll) because the
 * tls cases read certs cwd-relative and the drivers resolve
 * ../../certs relative to their own shipped location. */

interface FixtureRun {
  stdout: Buffer;
  exitCode: number;
  /** The driver's stdout, "" for driver-less cases. */
  driverStdout: string;
}

function fixtureCases(root: string): { name: string; entry: string; driver: string | null }[] {
  if (!enabled) return [];
  return globSync(join(root, "cases/*/main.ts"))
    .sort()
    .filter((f) => filter === undefined || new RegExp(filter).test(f))
    .map((entry) => ({
      name: entry.split("/").at(-2)!,
      entry,
      driver: existsSync(join(entry, "../driver.mjs")) ? join(entry, "../driver.mjs") : null,
    }));
}

const serverCases = fixtureCases(join(repoRoot, "tests/fixtures/server"));
const dgramCases = fixtureCases(join(repoRoot, "tests/fixtures/dgram"));
const fetchCases = fixtureCases(join(repoRoot, "tests/fixtures/fetch"));

/** A repo-relative fixture path's spelling in a box-side command. */
function boxRel(hostPath: string): string {
  if (!hostPath.startsWith(repoRoot)) throw new Error(`not under the repo: ${hostPath}`);
  return hostPath.slice(repoRoot.length + 1).replaceAll("/", "\\");
}

/** Runs one fixture lane ON THE BOX: spawn the fixture over ssh (cwd = the
 * lane dir, so cwd-relative cert reads resolve into the shipped tree),
 * follow the PORT protocol when the case has a driver (a SECOND ssh
 * session running the box's node against loopback), and collect all three
 * compared legs. The PORT match tolerates a trailing \r — remote stderr
 * rides ssh untranslated, but the tolerance costs nothing and decouples
 * the harness from CRT text-mode trivia. */
function runBoxFixtureLane(remoteCmd: string, driver: string | null): Promise<FixtureRun> {
  const full = `cd /d ${laneDirWin} && set SCRIPTC_TEST_ENV=from-harness&& ${remoteCmd}`;
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshOpts, host, full], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let errText = "";
    let driverStarted = false;
    let driverStdout = "";
    let driverDone: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A hung LISTENER outlives its ssh session (observed: killing the
      // local client leaves the remote .exe alive, wedging every later
      // scp of the same name) — so the native leg also reaps its own
      // process by image name, which is lane-unique (<case>.exe). The
      // node leg gets no such sweep: node.exe is not ours to blanket-kill
      // on a shared box.
      const exe = /^(\S+\.exe)$/.exec(remoteCmd)?.[1];
      const reaped = exe !== undefined ? runOnBox(`taskkill /F /IM ${exe}`).then(() => undefined, () => undefined) : Promise.resolve();
      void reaped.finally(() =>
        reject(new Error(`fixture timed out on the box\nstderr so far:\n${errText}`)),
      );
    }, 90_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      errText += c.toString("utf8");
      if (driver !== null && !driverStarted) {
        const m = /^PORT (\d+)\r?$/m.exec(errText);
        if (m) {
          driverStarted = true;
          driverDone = runOnBox(`node ${boxRel(driver)} ${m[1]!}`).then((res) => {
            driverStdout = res.stdout.toString("utf8");
            if (res.exitCode !== 0) {
              throw new Error(`driver exited ${res.exitCode}\n${res.stderr.toString("utf8")}`);
            }
          });
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`fixture ssh session died to ${signal}\nstderr:\n${errText}`));
        return;
      }
      if (driver !== null && !driverStarted) {
        reject(new Error(`fixture exited without a PORT line\nstderr:\n${errText}`));
        return;
      }
      driverDone.then(
        () => resolve({ stdout: Buffer.concat(out), exitCode: code ?? 0, driverStdout }),
        reject,
      );
    });
  });
}

/** Cross-compiles one fixture and ships the .exe to the lane dir (the
 * sources shipped once with the trees in beforeAll). */
async function shipFixture(c: { name: string; entry: string }): Promise<void> {
  const hash = createHash("sha256");
  for (const f of programInputs(c.entry)) hash.update(f).update(readFileSync(f));
  const key = hash.update("windows\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(c.entry, { outPath: join(outDir, `${c.name}.exe`), outDir, backend: "c" });
  if (!result.ok) {
    throw new Error(
      "fixture failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  await scpToLane([result.binaryPath]);
}

/* The machine-wide lane lock: two concurrent lane runs (parallel agents,
 * a stray second invocation) would stampede the shared box, so the run
 * queues behind an mkdir lock in the OS tmpdir. Stale locks from dead
 * processes are stolen after a bounded wait. */
const laneLockDir = join(tmpdir(), "scriptc-win-lane.lock");
async function acquireLaneLock(): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    try {
      mkdirSync(laneLockDir);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `another windows lane appears to be running (${laneLockDir} held for 10m) — remove the directory if it is stale.`,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

describe.skipIf(!enabled)(`windows differential (${target})`, () => {
  beforeAll(async () => {
    // Fail loudly, not skip: SCRIPTC_WIN=1 promises a Windows verdict.
    await execFileAsync("zig", ["version"]).catch(() => {
      throw new Error("SCRIPTC_WIN=1 needs zig on PATH (zigup) — the lane cross-compiles with `zig cc`.");
    });
    await acquireLaneLock();
    try {
      let nodeV: string;
      try {
        nodeV = (await execFileAsync("ssh", [...sshOpts, host, "node --version"])).stdout.trim();
      } catch (err) {
        throw new Error(`SCRIPTC_WIN=1 needs ssh access to '${host}' (see ~/.ssh/config): ${String(err)}`);
      }
      const pinned = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
      if (nodeV !== `v${pinned}`) {
        throw new Error(
          `the box's node is ${nodeV} but the lanes pin ${pinned} — the oracle must match the macOS lanes' version.`,
        );
      }
      // Fresh lane dir per run, then the shims the oracle imports.
      await execFileAsync("ssh", [...sshOpts, host, `cmd /c if exist ${laneDirWin} rmdir /S /Q ${laneDirWin}`]);
      await execFileAsync("ssh", [...sshOpts, host, `cmd /c mkdir ${laneDirWin}`]);
      await scpToLane([
        join(repoRoot, "tests/harness/comptime-shim.mjs"),
        join(repoRoot, "tests/harness/island-shim.mjs"),
        // The corpus package.json ({"type":"module"}): without it the
        // oracle's module detection can run export-less programs as sloppy
        // CJS, where the macOS oracle (and the compiler) see strict ESM.
        join(corpusDir, "package.json"),
      ]);
      // The fixture trees ship WHOLE, preserving the repo-relative layout:
      // the tls fixtures read certs cwd-relative from the lane dir and the
      // drivers resolve ../../certs from their own shipped location.
      const trees = [
        // Fetch's shared server reads the loopback HTTPS proxy certificate
        // from the server fixture tree. Keep that dependency staged even
        // when SCRIPTC_WIN_FILTER narrows the run to fetch cases only.
        ...(serverCases.length > 0 || fetchCases.length > 0
          ? [join(repoRoot, "tests/fixtures/server")]
          : []),
        ...(dgramCases.length > 0 ? [join(repoRoot, "tests/fixtures/dgram")] : []),
        // The fetch tree ships whole too: the box's Node runs the case
        // sources (their imports resolve into the shipped node_modules)
        // and the servers script serves both lanes from the box.
        ...(fetchCases.length > 0 ? [join(repoRoot, "tests/fixtures/fetch")] : []),
      ];
      if (trees.length > 0) {
        await execFileAsync("ssh", [...sshOpts, host, `cmd /c mkdir ${laneDirWin}\\tests\\fixtures`]);
        await execFileAsync("scp", ["-q", "-r", ...sshOpts, ...trees, `${host}:${laneDirScp}/tests/fixtures/`]);
      }
    } catch (err) {
      rmdirSync(laneLockDir);
      throw err;
    }
  }, 300_000);

  afterAll(async () => {
    // Box etiquette: delete the lane directory (every process the lane
    // started is a console child of an ssh session and dies with it — the
    // lane never launches anything detached), close the ssh master,
    // release the lane lock.
    await execFileAsync("ssh", [...sshOpts, host, `cmd /c rmdir /S /Q ${laneDirWin}`]).catch(() => undefined);
    await execFileAsync("ssh", [...sshOpts, "-O", "exit", host]).catch(() => undefined);
    try {
      rmdirSync(laneLockDir);
    } catch {
      /* already released */
    }
  }, 120_000);

  // skipIf(empty): a SCRIPTC_WIN_FILTER narrowing to fixtures only must not
  // fail the corpus suite for having no tests (and vice versa).
  describe.skipIf(files.length === 0)(`corpus (${files.length} programs)`, () => {
    test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
      "%s",
      async ([rel, file], ctx) => {
        const skip = WINDOWS_SKIPS[rel];
        if (skip !== undefined) ctx.skip(skip);
        let results: [RunResult, RunResult];
        try {
          await shipProgram(file); // compile gate + transport BEFORE either side runs
          results = await Promise.all([runWindowsNode(file), runOnBox(`${laneName(file)}.exe`)]);
        } catch (err) {
          // Cross-gated features SKIP with the gate's reason (none exist
          // today — the native fetch lifted the last win32 gate; the arm
          // stays for whatever gates next): they are later-phase scope,
          // not Windows failures. Everything else is a real failure.
          if (err instanceof Error && err.message.includes("not supported under a cross target")) {
            ctx.skip(err.message.split("\n").find((l) => l.includes("not supported")) ?? err.message);
          }
          throw err;
        }
        const [nodeRes, nativeRes] = results;
        if (!nodeRes.stdout.equals(nativeRes.stdout)) {
          expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
          expect.unreachable("stdout differed at byte level but not after utf8 decode");
        }
        const expectedExit = expectedExitCode(file);
        if (expectedExit === 0) {
          if (!nodeRes.stderr.equals(nativeRes.stderr)) {
            expect(nativeRes.stderr.toString("utf8")).toBe(nodeRes.stderr.toString("utf8"));
            expect.unreachable("stderr differed at byte level but not after utf8 decode");
          }
        }
        expect(nodeRes.exitCode).toBe(expectedExit);
        expect(nativeRes.exitCode).toBe(expectedExit);
      },
    );
  });

  for (const [label, cases] of [
    ["server", serverCases],
    ["dgram", dgramCases],
  ] as const) {
    describe.skipIf(cases.length === 0)(`${label} fixtures (${cases.length} cases)`, () => {
      test.for(cases.map((c) => [c.name, c] as const))(
        "%s",
        async ([, c], ctx) => {
          try {
            await shipFixture(c); // compile gate + transport BEFORE either side runs
          } catch (err) {
            // A case needing a still-gated feature skips with the gate's
            // reason (nothing in these fixture sets does today).
            if (err instanceof Error && err.message.includes("not supported under a cross target")) {
              ctx.skip(err.message.split("\n").find((l) => l.includes("not supported")) ?? err.message);
            }
            throw err;
          }
          // Sequential, not parallel: both lanes bind ephemeral loopback
          // ports and drive real sockets on the same box (server.test.ts's
          // stance).
          const nodeRes = await runBoxFixtureLane(`node ${boxRel(c.entry)}`, c.driver);
          const nativeRes = await runBoxFixtureLane(`${c.name}.exe`, c.driver);
          expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
          if (!nodeRes.stdout.equals(nativeRes.stdout)) {
            expect.unreachable("stdout differed at byte level but not after utf8 decode");
          }
          expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
          expect(nativeRes.driverStdout).toBe(nodeRes.driverStdout);
        },
        240_000,
      );
    });
  }

  /* ── the fetch fixture leg (tests/fixtures/fetch) — fetch.test.ts's
   * contract with every process ON THE BOX (the linux lane's shape): the
   * fixture servers run under the box's Node for the whole describe
   * (started over one long-lived ssh session; killed by PID at the end —
   * a remote process can outlive its ssh client, the hung-listener
   * lesson, and node.exe is not ours to blanket-kill on a shared box),
   * and each case runs under the box's Node AND cross-compiled
   * (--dynamic, the ambient fetch is island-backed), byte-compared, with
   * the POISONED proxy env both fetches must ignore. The opt-in arm
   * routes both lanes through the counting proxy and reads the count
   * over the wire (the /__count query). */
  describe.skipIf(fetchCases.length === 0)(`fetch fixtures (${fetchCases.length} cases)`, () => {
    let serversChild: ReturnType<typeof spawn> | undefined;
    let serversPid = "";
    let base = "";
    let refused = "";
    let proxyBase = "";
    const poison = (): Record<string, string> => ({
      http_proxy: refused,
      https_proxy: refused,
      HTTP_PROXY: refused,
      HTTPS_PROXY: refused,
    });

    beforeAll(async () => {
      // Start the servers on the box and hold the session; the bootstrap
      // prints the PID first so teardown can taskkill exactly this node.
      const boot =
        "const {startFetchServers}=await import('./tests/fixtures/fetch/servers.mjs');" +
        "const s=await startFetchServers();" +
        "process.stderr.write('PID '+process.pid+'\\nBASE '+s.baseUrl+'\\nREFUSED '+s.refusedUrl+'\\nPROXY '+s.proxyUrl+'\\n');";
      const full = `cd /d ${laneDirWin} && node --input-type=module -e "${boot}"`;
      const child = spawn("ssh", [...sshOpts, host, full], { stdio: ["ignore", "ignore", "pipe"] });
      serversChild = child;
      await new Promise<void>((resolve, reject) => {
        let errText = "";
        const timer = setTimeout(() => {
          reject(new Error(`fetch servers never reported their ports\nstderr so far:\n${errText}`));
        }, 60_000);
        child.stderr!.on("data", (c: Buffer) => {
          errText += c.toString("utf8");
          const pid = /^PID (\d+)\r?$/m.exec(errText);
          const b = /^BASE (\S+)\r?$/m.exec(errText);
          const r = /^REFUSED (\S+)\r?$/m.exec(errText);
          const p = /^PROXY (\S+)\r?$/m.exec(errText);
          if (pid && b && r && p) {
            [serversPid, base, refused, proxyBase] = [pid[1]!, b[1]!, r[1]!, p[1]!];
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`fetch servers exited ${code} before reporting ports`));
        });
      });
    }, 120_000);

    afterAll(async () => {
      if (serversPid !== "") {
        await runOnBox(`taskkill /F /PID ${serversPid}`).catch(() => undefined);
      }
      serversChild?.kill("SIGKILL");
    });

    /** Cross-compiles one fetch fixture (fetch.test.ts's build: always
     * --dynamic, the cache key covering the shared fixture node_modules)
     * and ships the .exe. */
    async function shipFetchFixture(c: { name: string; entry: string }): Promise<void> {
      const hash = createHash("sha256");
      const inputs = [
        c.entry,
        ...globSync(join(repoRoot, "tests/fixtures/fetch/node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
      ];
      for (const f of inputs) hash.update(f).update(readFileSync(f));
      const key = hash.update("windows-fetch\0").update(target).digest("hex").slice(0, 16);
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const result = await compile(c.entry, { outPath: join(outDir, `${c.name}.exe`), outDir, dynamic: true, backend: "c" });
      if (!result.ok) {
        throw new Error(
          "fetch fixture failed to cross-compile:\n" +
            result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
      await scpToLane([result.binaryPath]);
    }

    /** The proxy's relay count, read over the wire from the box. */
    async function proxiedCount(): Promise<number> {
      const res = await runOnBox(
        `node -e "fetch(process.argv[1] + '/__count').then((r) => r.text()).then((t) => process.stdout.write(t))" ${proxyBase}`,
      );
      expect(res.exitCode).toBe(0);
      return Number(res.stdout.toString("utf8"));
    }

    /** One case, both lanes on the box, byte-compared. Sequential, not
     * parallel: both lanes drive real sockets against the same servers. */
    async function runFetchCase(c: { name: string; entry: string }, env: Record<string, string>): Promise<void> {
      await shipFetchFixture(c);
      const argv = [base, refused];
      // The fragment redirect route remembers a caller-provided key. Node
      // and native must use distinct keys so the second lane also observes
      // the redirect instead of inheriting the first lane's server state.
      const nodeArgv = c.name === "redirect-resolution"
        ? [...argv, "redirect-resolution-node"]
        : argv;
      const nativeArgv = c.name === "redirect-resolution"
        ? [...argv, "redirect-resolution-native"]
        : argv;
      const nodeRes = await runOnBox(
        `node ${boxRel(c.entry)} ${nodeArgv.join(" ")}`,
        env,
      );
      const nativeRes = await runOnBox(
        `${c.name}.exe ${nativeArgv.join(" ")}`,
        env,
      );
      if (!nodeRes.stdout.equals(nativeRes.stdout)) {
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect.unreachable("stdout differed at byte level but not after utf8 decode");
      }
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    }

    test.for(fetchCases.map((c) => [c.name, c] as const))(
      "%s",
      async ([, c]) => {
        await runFetchCase(c, poison());
      },
      240_000,
    );

    test.skipIf(fetchCases.every((c) => c.name !== "proxy-optin"))(
      "proxy-optin routes through http_proxy when opted in",
      async () => {
        const c = fetchCases.find((x) => x.name === "proxy-optin")!;
        const before = await proxiedCount();
        await runFetchCase(c, {
          ...poison(),
          NODE_USE_ENV_PROXY: "1",
          http_proxy: proxyBase,
          HTTP_PROXY: proxyBase,
        });
        expect((await proxiedCount()) - before).toBe(2);
      },
      240_000,
    );
  });
});
