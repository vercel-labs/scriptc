/* Node's module compile cache for a program's Node island
 * (scr_node_island.c, "Node's compile cache"): where the runtime puts it,
 * which launches write it, and every way its directory can be unusable or
 * not the user's own. The cache changes how fast modules load and nothing
 * a differential program could print, so its behaviour is pinned here: by
 * what is on disk afterwards, by Node's own account of each module
 * (NODE_DEBUG_NATIVE=COMPILE_CACHE), and by the runtime's
 * (SCRIPTC_NODE_ISLANDS_TRACE=compile-cache). The fixture is
 * tests/fixtures/node-island/compile-cache. Needs a libnode pack in
 * SCRIPTC_LIBNODE (libnode.ts). */
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const fixture = join(repoRoot, "tests/fixtures/node-island/compile-cache");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-compile-cache");
const skip = libnodePack() === null;
/** Whether this user writes where a directory's mode forbids it and may give
 * a directory away (root, or a container user with every capability): the
 * read-only cases then prove less, and the other-owner case can run. */
function privileged(): boolean {
  const probe = join(outDir, "privilege-probe");
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  chmodSync(probe, 0o500);
  try {
    writeFileSync(join(probe, "file"), "");
    chownSync(probe, 65534, 65534);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const root = skip ? false : privileged();

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

let binary = "";

/** The environment of a launch: the test runner's, without a compile cache
 * setting of its own. */
function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "NODE_COMPILE_CACHE",
    "NODE_DISABLE_COMPILE_CACHE",
    "NODE_DEBUG_NATIVE",
    "SCRIPTC_NODE_ISLANDS_TRACE",
    "XDG_CACHE_HOME",
  ])
    delete env[name];
  return { ...env, ...extra };
}

async function launch(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { env, encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
  }
}

/** A launch of the fixture with `home` as the user's cache directory. */
function run(home: string, mode: string, extra: Record<string, string> = {}): Promise<Run> {
  return launch(binary, [mode], environment({ XDG_CACHE_HOME: home, ...extra }));
}

/** A cache home that does not exist yet, in a directory that does. */
function freshHome(name: string): string {
  const home = join(outDir, "homes", name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(outDir, "homes"), { recursive: true });
  return home;
}

const islandsOf = (home: string): string => join(home, "scriptc/node-islands");

/** The compile cache directories below a cache home. */
function cachesOf(home: string): string[] {
  const islands = islandsOf(home);
  if (!existsSync(islands)) return [];
  return readdirSync(islands)
    .filter((name) => name.endsWith(".compile-cache"))
    .map((name) => join(islands, name));
}

/** The files below a compile cache directory: Node's entries, and whatever
 * else is there. */
function filesOf(cache: string): string[] {
  return readdirSync(cache, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** An entry is named by eight hexadecimal digits; a write in progress has a
 * suffix. */
const entriesOf = (cache: string): string[] =>
  filesOf(cache).filter((name) => /^[0-9a-f]{8}$/.test(name));

/** How many modules Node took from the cache, and how many entries it wrote. */
function account(result: Run): { accepted: number; written: number; read: string[] } {
  const lines = result.stderr.split("\n");
  return {
    accepted: lines.filter((l) => l.includes("was accepted")).length,
    written: lines.filter((l) => l.includes("writing cache for")).length,
    read: lines
      .map((l) => /reading cache from (\S+) for/.exec(l)?.[1])
      .filter((path): path is string => path !== undefined),
  };
}

const debug = { NODE_DEBUG_NATIVE: "COMPILE_CACHE" };
const trace = { SCRIPTC_NODE_ISLANDS_TRACE: "compile-cache" };

/** The fixture's package has three modules that every island launch loads. */
const MODULES = 3;

async function build(source: string, name: string, flags: string[] = []): Promise<string> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "main");
  await execFileAsync(
    process.execPath,
    [cli, "build", join(source, "main.ts"), "-o", out, ...flags],
    {
      env: { ...process.env, SCRIPTC_CACHE_DIR: join(outDir, "build-cache") },
      encoding: "utf8",
    },
  );
  return out;
}

describe.skipIf(skip)("the compile cache of a Node island", () => {
  beforeAll(async () => {
    binary = await build(fixture, "program");
  }, 300_000);

  test("a program whose island never starts makes no directory", async () => {
    const home = freshHome("never");
    expect(await run(home, "none")).toEqual({ stdout: "no island\n", stderr: "", code: 0 });
    expect(existsSync(home)).toBe(false);
  });

  test("the first launch fills a private directory beside the tree, and later ones load from it", async () => {
    const home = freshHome("first");
    const first = await run(home, "directory");
    expect(first).toMatchObject({ stderr: "", code: 0 });
    const names = readdirSync(islandsOf(home)).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(names[1]).toBe(`${names[0]}.compile-cache`);
    const cache = join(islandsOf(home), names[1]!);
    expect(statSync(cache).mode & 0o777).toBe(0o700);
    // Node keeps its entries in a directory of its own version below it.
    const [version] = readdirSync(cache);
    expect(first.stdout).toBe(`sum 3\n${join(cache, version!)}\n`);
    expect(entriesOf(cache)).toHaveLength(MODULES);
    expect(filesOf(cache)).toEqual(entriesOf(cache));
    const second = await run(home, "return", debug);
    expect(second).toMatchObject({ stdout: "sum 3\n", code: 0 });
    expect(account(second)).toMatchObject({ accepted: MODULES, written: 0 });
    // A module the cache has not seen is compiled, and written when Node stops.
    const third = await run(home, "later", debug);
    expect(third.stdout).toBe("sum 3\nlater\n");
    expect(account(third)).toMatchObject({ accepted: MODULES, written: 1 });
    expect(entriesOf(cache)).toHaveLength(MODULES + 1);
  });

  test("process.exit() writes the entries, from native code and from island code", async () => {
    for (const mode of ["exit", "island-exit"]) {
      const home = freshHome(mode);
      expect(await run(home, mode)).toEqual({ stdout: "sum 3\n", stderr: "", code: 0 });
      expect(entriesOf(cachesOf(home)[0]!)).toHaveLength(MODULES);
    }
    // With nothing new the exit writes nothing.
    const again = await run(join(outDir, "homes/exit"), "exit", debug);
    expect(account(again)).toMatchObject({ accepted: MODULES, written: 0 });
  });

  test("a program that is ended by a signal has written its entries a second after the start", async () => {
    const home = freshHome("signal");
    const child = spawn(binary, ["stay"], {
      env: environment({ XDG_CACHE_HOME: home }),
      stdio: "ignore",
    });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on("close", (_code, signal) => resolve(signal)),
    );
    try {
      const deadline = Date.now() + 30_000;
      const written = (): number => cachesOf(home).flatMap(entriesOf).length;
      while (written() < MODULES && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(written()).toBe(MODULES);
    } finally {
      child.kill("SIGKILL");
    }
    expect(await closed).toBe("SIGKILL");
    expect(account(await run(home, "return", debug))).toMatchObject({ accepted: MODULES });
  }, 60_000);

  test("NODE_COMPILE_CACHE names the user's own directory, and the runtime makes none", async () => {
    const home = freshHome("users");
    const own = freshHome("users-directory");
    const result = await run(home, "exit", { NODE_COMPILE_CACHE: own, ...trace });
    expect(result).toMatchObject({ stdout: "sum 3\n", code: 0 });
    expect(result.stderr).toMatch(
      /^\[node-islands\] compile cache: NODE_COMPILE_CACHE's\n\[node-islands\] compile cache: written at process\.exit in [0-9.]+ ms\n$/,
    );
    expect(cachesOf(home)).toEqual([]);
    // Node also keeps the island's bootstrap there, since it turned the
    // cache on before the bootstrap ran.
    expect(entriesOf(own).length).toBeGreaterThanOrEqual(MODULES);
  });

  test("NODE_DISABLE_COMPILE_CACHE leaves the island without a cache", async () => {
    const home = freshHome("disabled");
    const result = await run(home, "directory", { NODE_DISABLE_COMPILE_CACHE: "1", ...trace });
    expect(result).toEqual({
      stdout: "sum 3\nnone\n",
      stderr: "[node-islands] compile cache: none (NODE_DISABLE_COMPILE_CACHE is set)\n",
      code: 0,
    });
    expect(cachesOf(home)).toEqual([]);
  });

  /** A launch against a cache directory the runtime must refuse: the program
   * runs as ever, Node has no cache, and nothing below the directory is read. */
  async function refused(home: string, cache: string): Promise<void> {
    const result = await run(home, "directory", { ...trace, ...debug });
    expect(result.stdout).toBe("sum 3\nnone\n");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      `[node-islands] compile cache: none (${cache} cannot be made, or is not a directory of ` +
        "this user's own that no one else can write)\n",
    );
    // Without the traces the refusal says nothing.
    expect(await run(home, "directory")).toEqual({ stdout: "sum 3\nnone\n", stderr: "", code: 0 });
  }

  test("a directory that someone else can write is refused", async () => {
    const home = freshHome("writable");
    await run(home, "return");
    const [cache] = cachesOf(home);
    for (const mode of [0o770, 0o707, 0o720, 0o702]) {
      chmodSync(cache!, mode);
      await refused(home, cache!);
    }
    // Readable by others is the user's business; the entries are used.
    chmodSync(cache!, 0o755);
    expect(account(await run(home, "return", debug))).toMatchObject({ accepted: MODULES });
  });

  test.skipIf(!root)("a directory that belongs to another user is refused", async () => {
    const home = freshHome("owner");
    await run(home, "return");
    const [cache] = cachesOf(home);
    chownSync(cache!, 65534, 65534);
    await refused(home, cache!);
  });

  test("a link or a file in the directory's place is refused, and the link is not followed", async () => {
    const home = freshHome("link");
    await run(home, "return");
    const [cache] = cachesOf(home);
    const elsewhere = freshHome("link-target");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(cache!, { recursive: true });
    symlinkSync(elsewhere, cache!);
    await refused(home, cache!);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(cache!);
    writeFileSync(cache!, "not a directory\n");
    await refused(home, cache!);
    expect(readFileSync(cache!, "utf8")).toBe("not a directory\n");
  });

  test("a cache home that is a link is the user's choice and is used", async () => {
    const real = freshHome("home-real");
    const link = freshHome("home-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const result = await run(link, "directory");
    expect(result).toMatchObject({ stderr: "", code: 0 });
    expect(result.stdout.startsWith(`sum 3\n${islandsOf(link)}/`)).toBe(true);
    expect(entriesOf(cachesOf(real)[0]!)).toHaveLength(MODULES);
  });

  test("a directory that cannot be written is read, and a failed write says nothing", async () => {
    const home = freshHome("read-only");
    await run(home, "return");
    const [cache] = cachesOf(home);
    const [version] = readdirSync(cache!);
    chmodSync(join(cache!, version!), 0o500);
    try {
      // The cache holds three modules; this launch loads a fourth.
      const result = await run(home, "later", debug);
      expect(result).toMatchObject({ stdout: "sum 3\nlater\n", code: 0 });
      expect(account(result).accepted).toBe(MODULES);
      if (!root) expect(filesOf(cache!)).toHaveLength(MODULES);
      expect(await run(home, "later")).toEqual({ stdout: "sum 3\nlater\n", stderr: "", code: 0 });
    } finally {
      chmodSync(join(cache!, version!), 0o700);
    }
    // An empty directory the user may not write: Node cannot make its own
    // directory below it and runs without a cache.
    rmSync(join(cache!, version!), { recursive: true });
    chmodSync(cache!, 0o500);
    try {
      const result = await run(home, "directory");
      expect(result).toMatchObject({ stderr: "", code: 0 });
      if (!root) expect(result.stdout).toBe("sum 3\nnone\n");
    } finally {
      chmodSync(cache!, 0o700);
    }
  });

  test("a launch whose writes all fail runs as ever, and the next one fills the cache", async () => {
    const home = freshHome("no-room");
    // The tree is installed by a launch that may write.
    await run(home, "return", { NODE_DISABLE_COMPILE_CACHE: "1" });
    // No file may grow from here on, as on a disk without room (the signal
    // the limit raises is ignored, so a write fails with an error instead).
    const limited = await launch(
      "/bin/sh",
      ["-c", 'trap "" XFSZ; ulimit -f 0; exec "$0" "$@"', binary, "later"],
      environment({ XDG_CACHE_HOME: home }),
    );
    expect(limited).toEqual({ stdout: "sum 3\nlater\n", stderr: "", code: 0 });
    const [cache] = cachesOf(home);
    expect(entriesOf(cache!)).toEqual([]);
    const next = await run(home, "later", debug);
    expect(next.stdout).toBe("sum 3\nlater\n");
    expect(account(next)).toMatchObject({ accepted: 0, written: MODULES + 1 });
    expect(account(await run(home, "later", debug))).toMatchObject({
      accepted: MODULES + 1,
      written: 0,
    });
  });

  test("first launches at the same time all run, and leave one whole set of entries", async () => {
    const home = freshHome("together");
    const results = await Promise.all(Array.from({ length: 8 }, () => run(home, "later")));
    for (const result of results)
      expect(result).toEqual({ stdout: "sum 3\nlater\n", stderr: "", code: 0 });
    expect(readdirSync(islandsOf(home))).toHaveLength(2);
    const [cache] = cachesOf(home);
    expect(entriesOf(cache!)).toHaveLength(MODULES + 1);
    expect(filesOf(cache!)).toEqual(entriesOf(cache!));
    expect(account(await run(home, "later", debug))).toMatchObject({
      accepted: MODULES + 1,
      written: 0,
    });
  });

  test("another build of the program has another directory and reads nothing of this one's", async () => {
    // The same program with one changed line in one package file.
    const source = join(outDir, "variant-source");
    rmSync(source, { recursive: true, force: true });
    cpSync(fixture, source, { recursive: true });
    const changed = join(source, "node_modules/cache-pkg/b.js");
    writeFileSync(changed, readFileSync(changed, "utf8").replace("() => 0;", "() => 0 + 0;"));
    const variant = await build(source, "variant");
    const home = freshHome("builds");
    await run(home, "return");
    const [first] = cachesOf(home);
    const before = filesOf(first!);
    const result = await launch(
      variant,
      ["return"],
      environment({ XDG_CACHE_HOME: home, ...debug }),
    );
    expect(result).toMatchObject({ stdout: "sum 3\n", code: 0 });
    const second = cachesOf(home).find((cache) => cache !== first);
    expect(second).toBeDefined();
    expect(readdirSync(islandsOf(home))).toHaveLength(4);
    const { accepted, read, written } = account(result);
    expect([accepted, written, read.length]).toEqual([0, MODULES, MODULES]);
    for (const path of read) expect(path.startsWith(`${second}/`)).toBe(true);
    expect(filesOf(first!)).toEqual(before);
  }, 300_000);

  test("without a home directory the tree is one run's own copy and has no cache", async () => {
    const tmp = freshHome("tmp");
    mkdirSync(tmp, { recursive: true });
    const env = environment({ TMPDIR: tmp, ...trace });
    delete env["HOME"];
    expect(await launch(binary, ["directory"], env)).toEqual({
      stdout: "sum 3\nnone\n",
      stderr:
        "[node-islands] compile cache: none (the module tree is this run's own temporary copy)\n",
      code: 0,
    });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a program shipped with its modules beside it keeps its cache in the user's directory", async () => {
    const beside = await build(fixture, "beside", ["--libnode=beside"]);
    const home = freshHome("beside");
    const env = environment({ XDG_CACHE_HOME: home });
    delete env["SCRIPTC_LIBNODE"];
    const first = await launch(beside, ["directory"], env);
    expect(first).toMatchObject({ stderr: "", code: 0 });
    // The tree is not installed there: the cache is the directory's one entry.
    const names = readdirSync(islandsOf(home));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.compile-cache$/);
    expect(first.stdout.startsWith(`sum 3\n${join(islandsOf(home), names[0]!)}/`)).toBe(true);
    const second = await launch(beside, ["return"], { ...env, ...debug });
    expect(account(second)).toMatchObject({ accepted: MODULES, written: 0 });
  }, 300_000);
});
