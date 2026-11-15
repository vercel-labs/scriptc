/* Deferred Node island modules whose load reads the machine or the moment:
 * a clock, the time zone, the default locale, the terminal, the home and
 * working directories, the process id, a random number. Each program is
 * built under one machine setting and run under another, and must print
 * what Node prints under the setting it runs in: nothing of the build
 * machine or of the build's moment may be in the executable, and a load
 * that reads a clock must read it where it is imported. The programs are
 * corpus programs 9811 to 9817 (the differential suites run them where they
 * are built). Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-load-reads");
const skip = libnodePack() === null;

/** The variables a machine setting is made of here. A build or a run starts
 * without them and sets the ones its case names. */
const SETTING = [
  "TZ",
  "LC_ALL",
  "LC_MESSAGES",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TMPDIR",
  "TMP",
  "TEMP",
];

function setting(set: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SETTING) delete env[key];
  return { ...env, ...set };
}

/** A fresh directory of this suite, by its real path. */
function directory(name: string): string {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** Builds a corpus program under `set`; answers the binary and what the
 * build decided for each island package, by the package's name. */
async function build(
  name: string,
  entry: string,
  set: Record<string, string> = {},
): Promise<{ binary: string; decision: (pkg: string) => string }> {
  const dir = directory(name);
  const binary = join(dir, "main");
  const env = {
    ...setting(set),
    SCRIPTC_NODE_ISLANDS_TRACE: "defer",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
  };
  const { stderr } = await execFileAsync(
    process.execPath,
    [cli, "build", join(corpus, name, entry), "-o", binary],
    { env, encoding: "utf8" },
  );
  const lines = stderr.split("\n").filter((l) => /^\[node-islands\] (defer|eager) /.test(l));
  return {
    binary,
    decision: (pkg) => {
      const line = lines.find((l) => l.includes(`node_modules/${pkg}/`));
      expect(line, `${pkg} in\n${stderr}`).toBeDefined();
      return line!.slice("[node-islands] ".length);
    },
  };
}

/** stdout of the binary under `set`, and whether Node started. */
async function run(
  binary: string,
  set: Record<string, string> = {},
  cwd?: string,
): Promise<{ stdout: string; startsNode: boolean }> {
  const env = {
    ...setting(set),
    XDG_CACHE_HOME: join(outDir, "cache"),
    SCRIPTC_NODE_ISLANDS_TRACE: "boot",
  };
  const { stdout, stderr } = await execFileAsync(binary, [], { env, encoding: "utf8", cwd });
  return { stdout, startsNode: stderr.includes("[node-islands] starting Node") };
}

/** stdout of the program under Node, under `set`. */
async function underNode(
  name: string,
  entry: string,
  set: Record<string, string> = {},
  cwd?: string,
): Promise<string> {
  return (
    await execFileAsync(process.execPath, [join(corpus, name, entry)], {
      env: setting(set),
      encoding: "utf8",
      cwd,
    })
  ).stdout;
}

/** stdout of a command run under a pseudo-terminal by script(1). util-linux's
 * takes the command with -c; the BSD one on macOS takes it after the
 * transcript file, needs a stdin that is not a socket, and echoes the EOF it
 * forwards from /dev/null as ^D and two backspaces. */
async function underTerminal(command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "darwin") {
    const quoted = command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
    return (await execFileAsync("script", ["-qec", quoted, "/dev/null"], { env, encoding: "utf8" }))
      .stdout;
  }
  const child = spawn("script", ["-q", "/dev/null", ...command], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(0);
  return stdout.replaceAll("^D\b\b", "");
}

describe.skipIf(skip)("island loads that read the machine or the moment", () => {
  test("a load that reads a clock evaluates where it is imported", async () => {
    const name = "9811-node-island-load-reads-clock";
    const { binary, decision } = await build(name, "main.cjs");
    for (const [pkg, clock] of [
      ["stamp-kit", "Date.now()"],
      ["made-kit", "new Date()"],
      ["tick-kit", "process.hrtime()"],
      ["timer-kit", "performance.now()"],
    ] as const) {
      const line = decision(pkg);
      expect(line, pkg).toMatch(/^eager /);
      expect(line, pkg).toContain(`its load reads ${clock} (`);
      expect(line, pkg).toContain(`node_modules/${pkg}/index.js:`);
      expect(line, pkg).toContain("no run repeats the reading");
    }
    const ran = await run(binary);
    expect(ran.stdout).toBe(await underNode(name, "main.cjs"));
    expect(ran.stdout.match(/: true$/gm)).toHaveLength(4);
  }, 300_000);

  test("the time zone and the default locale are the run's, not the build's", async () => {
    const name = "9812-node-island-load-reads-zone-locale";
    // Built on a machine with no TZ and no locale variables.
    const { binary, decision } = await build(name, "main.cjs");
    for (const pkg of ["zone-kit", "calendar-kit"]) {
      expect(decision(pkg), pkg).toMatch(/^eager /);
      expect(decision(pkg), pkg).toContain("the time zone of the machine (TZ is unset) (");
    }
    // A load that names its zone and its locale reads neither.
    expect(decision("fixed-kit")).toMatch(/^defer /);
    expect(decision("fixed-kit")).not.toContain("guards");
    if (process.platform === "linux") {
      expect(decision("locale-kit")).toMatch(/^defer /);
      expect(decision("locale-kit")).toContain(
        "env guards LC_ALL (unset),LC_MESSAGES (unset),LANG (unset)",
      );
    } else {
      expect(decision("locale-kit")).toMatch(/^eager .*the default locale/);
    }
    // Run where it was built, in another zone, and in another zone and locale.
    for (const set of [
      {},
      { TZ: "Asia/Tokyo" },
      { TZ: "America/St_Johns", LC_ALL: "sv_SE.UTF-8" },
      { LANG: "de_DE.UTF-8" },
    ]) {
      const expected = await underNode(name, "main.cjs", set);
      expect((await run(binary, set)).stdout, JSON.stringify(set)).toBe(expected);
    }
    const tokyo = await run(binary, { TZ: "Asia/Tokyo" });
    expect(tokyo.stdout).toContain("zone: Asia/Tokyo\n");
    expect(tokyo.stdout).toContain("offset: -540 -32400000\n");
    expect(tokyo.stdout).toContain("utc member: undefined\n");
    expect(tokyo.stdout).toContain(
      "fixed: 4733510400000 2020-01-01T00:00:00.000Z 0 1/1/2020, 12:00:00 AM 1.234,5 1\n",
    );
  }, 300_000);

  test("an argument only the load's own code can answer keeps the load where it is imported", async () => {
    // The recorder classifies a locale-sensitive call from its arguments.
    // It reads them only where no getter, proxy trap or conversion of the
    // load's would run, and counts an argument as plain only when nothing
    // on it can run while the call reads it: otherwise the load's code
    // could take the zone or the locale list away after the recorder
    // looked, and the build machine's answer would be in the executable.
    const name = "9817-node-island-load-reads-argument-accessors";
    const { binary, decision } = await build(name, "main.cjs");
    for (const pkg of ["options-kit", "tags-kit", "file-kit", "shifting-kit"]) {
      expect(decision(pkg), pkg).toMatch(/^eager /);
      expect(decision(pkg), pkg).toContain("that only the load's own code can answer");
    }
    for (const set of [{}, { TZ: "America/St_Johns", LC_ALL: "sv_SE.UTF-8" }]) {
      const expected = await underNode(name, "main.cjs", set);
      expect((await run(binary, set)).stdout, JSON.stringify(set)).toBe(expected);
    }
    const moved = await run(binary, { TZ: "America/St_Johns", LC_ALL: "sv_SE.UTF-8" });
    expect(moved.stdout).toContain("removed: America/St_Johns America/St_Johns 1\n");
    // A load that generates a key pair generates it in every run: nothing
    // of the build's pair is in the executable.
    expect(decision("key-kit")).toMatch(/^eager /);
    expect(decision("key-kit")).toContain("its load reads crypto.createECDH() (");
    const generated = async (): Promise<string> => {
      const line = (await run(binary, { SHOW_GENERATED_KEYS: "1" })).stdout
        .split("\n")
        .find((l) => l.startsWith("generated: "));
      expect(line).toMatch(/^generated: [0-9a-f]{130} [0-9a-f]{64}$/);
      return line!;
    };
    const first = await generated();
    const second = await generated();
    expect(second).not.toBe(first);
    expect(second.split(" ")[2]).not.toBe(first.split(" ")[2]);
  }, 300_000);

  test("a locale variable set at build time is not recorded, and the run's locale still answers", async () => {
    const name = "9812-node-island-load-reads-zone-locale";
    const { binary, decision } = await build(name, "main.cjs", {
      LC_ALL: "sv_SE.UTF-8",
      TZ: "UTC",
    });
    if (process.platform === "linux")
      expect(decision("locale-kit")).toMatch(
        /^eager .*the environment variable LC_ALL, set at build time/,
      );
    // TZ names the zone, and a variable with a value is recorded only when
    // the project lists it.
    expect(decision("zone-kit")).toMatch(
      /^eager .*the environment variables? TZ\b.* set at build time/,
    );
    for (const set of [{}, { TZ: "Asia/Tokyo", LC_ALL: "de_DE.UTF-8" }])
      expect((await run(binary, set)).stdout, JSON.stringify(set)).toBe(
        await underNode(name, "main.cjs", set),
      );
  }, 300_000);

  test("what only a terminal's stream has is the run's stream's", async () => {
    const name = "9813-node-island-load-reads-terminal";
    // The build's own streams are never a terminal.
    const { binary, decision } = await build(name, "main.cjs");
    expect(decision("term-kit")).toMatch(/^defer /);
    expect(decision("colour-kit")).toMatch(/^defer /);
    expect(decision("colour-kit")).toContain("env guards NO_COLOR (unset),FORCE_COLOR (unset)");
    // On pipes the guards hold: the snapshots answer and Node never starts.
    const piped = await run(binary);
    expect(piped.stdout).toBe(await underNode(name, "main.cjs"));
    expect(piped.stdout).toContain("getColorDepth: undefined hasColors: false\n");
    expect(piped.startsNode).toBe(false);
    // On a terminal the modules evaluate at their imports.
    const env = { ...setting({ TERM: "xterm-256color" }), XDG_CACHE_HOME: join(outDir, "cache") };
    const onTerminal = await underTerminal([binary], env);
    expect(onTerminal).toBe(
      await underTerminal([process.execPath, join(corpus, name, "main.cjs")], env),
    );
    expect(onTerminal).toContain("getColorDepth: function hasColors: true");
    expect(onTerminal).toContain("sized: true getWindowSize: true");
    expect(onTerminal).toContain("colour: 2 2");
    // A run that forces colour on a pipe fails the variable's guard.
    for (const set of [{ FORCE_COLOR: "1" }, { NO_COLOR: "1" }])
      expect((await run(binary, set)).stdout, JSON.stringify(set)).toBe(
        await underNode(name, "main.cjs", set),
      );
  }, 300_000);

  test("the directories, the process and a random number are the run's, and an unlisted source is named", async () => {
    const name = "9814-node-island-load-reads-run";
    const built = directory(`${name}-built-home`);
    const { binary, decision } = await build(name, "main.cjs", { HOME: built });
    expect(decision("ident-kit")).toMatch(/^eager .*its load reads process\.pid \(/);
    expect(decision("seed-kit")).toMatch(/^eager .*its load reads Math\.random\(\) \(/);
    // A package loaded after it reads what it left in a global: Node is
    // running by then, and the package evaluates at its import. The build
    // writes no snapshot for it, or for any load after the draw: the
    // snapshot would hold the build's draw and answer no run.
    for (const pkg of ["echo-kit", "plain-kit"])
      expect(decision(pkg), pkg).toMatch(
        /^eager .*an earlier load reads Math\.random\(\) \(.* could hold the build's reading/,
      );
    // What the recorder has no rule for keeps the load eager, with the source
    // and the place that read it.
    const odd = decision("odd-kit");
    expect(odd).toMatch(/^eager /);
    expect(odd).toContain("process.report, which the recorder does not classify (");
    expect(odd).toContain("node_modules/odd-kit/index.js:2:");
    expect(decision("place-kit")).toMatch(/^eager /);
    // Run from another directory, with another home and temporary directory.
    const elsewhere = directory(`${name}-run`);
    const set = { HOME: join(elsewhere, "home"), TMPDIR: join(elsewhere, "tmp") };
    mkdirSync(set.HOME, { recursive: true });
    mkdirSync(set.TMPDIR, { recursive: true });
    const ran = await run(binary, set, elsewhere);
    expect(ran.stdout).toBe(await underNode(name, "main.cjs", set, elsewhere));
    expect(ran.stdout).toContain("seed: number true\n");
    expect(ran.stdout).toContain("process: true true\n");
  }, 300_000);

  test("two builds of a program whose loads read the moment are the same bytes", async () => {
    // Each build draws its own random number, reads its own clock and has
    // its own process id while it evaluates the loads. None of that may be
    // in the executable, used or not.
    for (const [name, entry] of [
      ["9814-node-island-load-reads-run", "main.cjs"],
      ["9811-node-island-load-reads-clock", "main.cjs"],
      ["9816-node-island-load-imports-process-names", "main.mjs"],
    ] as const) {
      // The second build starts from an empty directory and an empty cache.
      const first = readFileSync((await build(name, entry)).binary);
      const second = readFileSync((await build(name, entry)).binary);
      expect(second.length, name).toBe(first.length);
      expect(second.equals(first), name).toBe(true);
    }
  }, 600_000);

  test('"evaluate": "lazy" defers a load that reads the machine, without the build\'s reading', async () => {
    const name = "9815-node-island-lazy-load-reads-machine";
    const { binary, decision } = await build(name, "main.cjs");
    const line = decision("lazy-kit");
    expect(line).toMatch(/^defer /);
    expect(line).toContain('"evaluate": "lazy"');
    expect(line).toContain("the time zone of the machine (TZ is unset)");
    expect(line).toContain("os.hostname()");
    expect(line).toContain(": no constants");
    for (const set of [{}, { TZ: "Asia/Tokyo" }])
      expect((await run(binary, set)).stdout, JSON.stringify(set)).toBe(
        await underNode(name, "main.cjs", set),
      );
  }, 300_000);

  test("an ES module's import of a process member by name is the read", async () => {
    const name = "9816-node-island-load-imports-process-names";
    const { binary, decision } = await build(name, "main.mjs");
    expect(decision("first-kit")).toMatch(/^defer /);
    expect(decision("second-kit")).toMatch(
      /^eager .*its load reads process\.pid \(an import by name in /,
    );
    // Node is running once the second has evaluated: the third has no
    // snapshot to answer from.
    expect(decision("third-kit")).toMatch(/^eager .*an earlier load reads process\.pid \(/);
    const ran = await run(binary);
    expect(ran.stdout).toBe(await underNode(name, "main.mjs"));
    expect(ran.stdout).toContain("second: true true\n");
  }, 300_000);
});
