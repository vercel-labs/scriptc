/* Island-closed module-level constants (compiler frontend/lowering/
 * closed-island-init.ts): what the build decides for their generated island
 * modules, and when Node starts in a program that declares them. The
 * programs are corpus programs (their output is compared with Node's
 * there); this file reads the build's deferral trace and the run's boot
 * trace. Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-closed-init");
const skip = libnodePack() === null;

const islandLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.startsWith("[node-islands] "));

/** Builds a corpus program (or the fixture at `entry`) with the build
 * traces on; answers the binary, the deferral decisions (`trace`) and
 * what the build said of each constant (`closed`). */
async function build(
  name: string,
  entry = join(corpus, name, "main.ts"),
): Promise<{ binary: string; trace: string[]; closed: string[] }> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "defer,closed",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
  };
  const { stderr } = await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
    env,
    encoding: "utf8",
  });
  const lines = islandLines(stderr);
  return {
    binary,
    trace: lines.filter((l) => /^\[node-islands\] (defer|eager) /.test(l)),
    closed: lines.filter((l) => /^\[node-islands\] (not )?closed /.test(l)),
  };
}

/** Runs `binary` with the boot trace on; answers its stdout, its boot
 * trace and its exit status. */
async function run(binary: string): Promise<{ stdout: string; boot: string[]; code: number }> {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: join(outDir, "cache"),
    SCRIPTC_NODE_ISLANDS_TRACE: "boot",
  };
  try {
    const { stdout, stderr } = await execFileAsync(binary, [], { env, encoding: "utf8" });
    return { stdout, boot: islandLines(stderr), code: 0 };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw e;
    return {
      stdout: failed.stdout ?? "",
      boot: islandLines(failed.stderr ?? ""),
      code: failed.code,
    };
  }
}

/** A decision about a generated module (not one whose reason names one). */
const generated = (line: string): boolean =>
  /^\[node-islands\] \w+ [^:]*\.scriptc\/closed\//.test(line);
const startsNode = (boot: string[]): boolean => boot.some((l) => l.includes("starting Node"));

describe.skipIf(skip)("island-closed module-level constants", () => {
  test("unused constants are deferred island modules, and Node never starts", async () => {
    const { binary, trace } = await build("8910-node-island-closed-const-unused");
    const modules = trace.filter(generated);
    // One generated module per constant.
    expect(modules).toHaveLength(3);
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] defer .*recorded evaluation is deterministic/);
    const { boot, code } = await run(binary);
    expect(code).toBe(0);
    expect(boot.filter((l) => l.includes("deferred ./.scriptc/closed/"))).toHaveLength(3);
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("primitive constants come from the snapshot without Node", async () => {
    const { binary, trace } = await build("8935-node-island-closed-const-primitive");
    expect(trace.filter(generated).every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("5 true v4.12.1 7\nlibnode mapped: false\n");
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("an exit before any use leaves the constants unevaluated", async () => {
    const { binary } = await build("8920-node-island-closed-const-exit");
    const { boot, code } = await run(binary);
    expect(code).toBe(3);
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("an initializer with effects evaluates where its constant is declared", async () => {
    const { binary, trace } = await build("8918-node-island-closed-const-prints");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(3);
    // The build does not print for the program: the probe withholds the
    // write (console.log swallows the refusal, so the evaluation goes on and
    // the record names the effect), and the two modules that print keep
    // their place. The third names the second and stays with it: a module
    // is not deferred when a load it shares a file with has effects.
    for (const module of modules) expect(module).toMatch(/^\[node-islands\] eager /);
    const printing = modules.filter((l) => l.includes(": its load has effects: process.stdout"));
    expect(printing).toHaveLength(2);
    expect(modules.filter((l) => l.includes(": it shares "))).toHaveLength(1);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "before\nshape-kit: making first\nbetween\nshape-kit: making second\nafter 1 2 3\n",
    );
  }, 300_000);

  test.each([
    ["effects", "scriptc-closed-init-effects.stamp", "fs\\.writeFileSync\\(\\)", "stamped true\n"],
    // Opening a file for writing creates it before anything is written.
    [
      "effects-open",
      "scriptc-closed-init-effects-open.stamp",
      "fs\\.openSync\\(\\)",
      "touched true\n",
    ],
  ])(
    "the build does not perform an initializer's effects (%s)",
    async (fixture, file, operation, output) => {
      const stamp = join(tmpdir(), file);
      rmSync(stamp, { force: true });
      try {
        const { binary, trace } = await build(
          fixture,
          join(repoRoot, "tests/fixtures/node-island/closed-init", fixture, "main.ts"),
        );
        // The probe stopped at the call: the file does not exist after the
        // build, and the module evaluates where the constant is declared.
        expect(existsSync(stamp)).toBe(false);
        const modules = trace.filter(generated);
        expect(modules).toHaveLength(1);
        expect(modules[0]).toMatch(
          new RegExp(`^\\[node-islands\\] eager .*${operation}.*which the build does not perform`),
        );
        const { stdout } = await run(binary);
        expect(stdout).toBe(output);
        expect(existsSync(stamp)).toBe(true);
      } finally {
        rmSync(stamp, { force: true });
      }
    },
    300_000,
  );

  test("a refusal the island package catches does not make its fallback the constant", async () => {
    const { binary, trace } = await build("8932-node-island-closed-const-caught-refusal");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(2);
    // The first initializer's package catches the refused read and returns
    // a fallback; the second's lets it through. Both records name the read,
    // and both constants evaluate in the run.
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] eager .*fs\.readFileSync\(\)/);
    const { stdout } = await run(binary);
    expect(stdout).toBe("measure twice 14\n");
  }, 300_000);

  test("the build says which constants the island evaluates, and what keeps the others native", async () => {
    const { closed } = await build("8940-node-island-closed-const-mixed");
    const said = closed.map((l) => l.replace(/ \S*\/main\.ts:/, " main.ts:"));
    expect(said).toEqual([
      "[node-islands] not closed main.ts:10 bounded: its initializer holds a constant the island does not evaluate (`limit`)",
      "[node-islands] closed main.ts:11 tags",
      "[node-islands] closed main.ts:13 tagged",
      "[node-islands] closed main.ts:14 closed",
    ]);
  }, 300_000);

  test("a constant declared after Node started evaluates there, not from its snapshot", async () => {
    const { binary, trace } = await build("8939-node-island-closed-const-after-call");
    // Every module is deferred by the build, and none in per-module mode: a
    // load reached while Node runs evaluates at its position.
    expect(trace.every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    expect(trace.every((l) => l.includes("evaluated when Node starts"))).toBe(true);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("empty 0\n1 x,y 2\n");
    expect(
      boot.filter((l) =>
        /evaluating \.\/\.scriptc\/closed\/.* eagerly: Node is already running/.test(l),
      ),
    ).toHaveLength(2);
  }, 300_000);
});
