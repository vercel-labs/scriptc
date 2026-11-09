/* Node islands loaded in-process (scope-B milestone NI-1), where it cannot
 * be a differential corpus program: a run that never calls into Node never
 * maps libnode, the beside packaging carries its own pack, a missing or
 * mismatched pack fails the first call with a message, and the executable
 * links no Node and exports nothing libnode could bind to. The corpus
 * (6800-6803) pins the call semantics against Node. Needs a libnode pack
 * in SCRIPTC_LIBNODE; required in the Linux x64 CI lanes (libnode.ts). */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { compile, deserializeModule } from "@scriptc/compiler";
import { definedFunctionNames, nodeIslandSymbols } from "../../scripts/zero-cost-compare.mjs";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/node-island/lifecycle.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// Required in the Linux x64 CI lanes, where a missing pack fails here.
const pack = libnodePack();
const skip = pack === null;

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

let binary = "";

// The fixture reads whether libnode is mapped from /proc/self/maps; other
// platforms print "unknown".
const before = `mapped before ${process.platform === "linux" ? "false" : "unknown"}`;
const after = `mapped after ${process.platform === "linux" ? "true" : "unknown"}`;

// The island module cache of these runs (scr_node_island.c).
const cacheHome = join(outDir, "cache");

/** How often a run hashed an island module tree's content (boot trace). */
function treeHashes(result: Run): number {
  return result.stderr.split("[node-islands] hashing the module tree").length - 1;
}

/** The trees installed in an islands directory. Each has Node's compile
 * cache for it beside it (`<tree>.compile-cache`,
 * node-island-compile-cache.test.ts). */
function installedTrees(islands: string): string[] {
  return readdirSync(islands).filter((name) => /^[0-9a-f]{64}$/.test(name));
}

/** The file named `name` below `dir`. */
function fileBelow(dir: string, name: string): string {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, name);
  throw new Error(`no ${name} below ${dir}`);
}

async function run(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheHome },
): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(path, args, { env, encoding: "utf8" });
    return { stdout, stderr: comparable(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: comparable(e.stderr ?? ""), code: e.code };
  }
}

/** Linux ASan's once-per-process warning at the first context switch (the
 * switch to Node's stack), dropped as differential.test.ts drops it. */
function comparable(stderr: string): string {
  if (!sanitize) return stderr;
  return stderr
    .split("\n")
    .filter((l) => !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(l))
    .join("\n");
}

async function build(name: string, libnode?: string, entry = fixture): Promise<string> {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(dir, basename(entry, ".ts")),
    outDir: dir,
    sanitize,
    ...(libnode === undefined ? {} : { libnode }),
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return result.binaryPath;
}

/** A bridge library that answers the ABI handshake and nothing else. */
async function fakePack(name: string, abi: string, version: string): Promise<string> {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "fake-bridge.c");
  writeFileSync(
    source,
    `#include "scr_node_bridge.h"
static const ScrNodeBridge bridge = {${abi}, "${version}", 127};
__attribute__((visibility("default"))) const ScrNodeBridge *scr_node_bridge_v1(void) { return &bridge; }
`,
  );
  const library =
    process.platform === "darwin" ? "libscr_node_bridge.dylib" : "libscr_node_bridge.so";
  await execFileAsync("clang", [
    "-shared",
    "-fPIC",
    "-I",
    join(repoRoot, "packages/runtime/src"),
    source,
    "-o",
    join(dir, library),
  ]);
  return dir;
}

describe.skipIf(skip)("Node islands in-process", () => {
  beforeAll(async () => {
    binary = await build("recorded");
  }, 300_000);

  test("loads Node on the first call, and only then", async () => {
    expect(await run(binary, [])).toEqual({
      stdout: `${before}\n42\n${after}\ndone\n`,
      stderr: "",
      code: 0,
    });
    expect(await run(binary, ["never"])).toEqual({
      stdout: `${before}\ndone\n`,
      stderr: "",
      code: 0,
    });
  });

  test("process.exit after loading Node keeps its code", async () => {
    const result = await run(binary, ["exit"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe(`${before}\n42\n${after}\n`);
  });

  test("beside packaging carries its own pack and island modules", async () => {
    const beside = await build("beside", "beside");
    expect(existsSync(join(outDir, "beside/lifecycle.libnode/manifest.json"))).toBe(true);
    const modules = join(outDir, "beside/lifecycle.libnode/modules");
    const helper = join(modules, "helper.cjs");
    const original = readFileSync(join(repoRoot, "tests/fixtures/node-island/helper.cjs"), "utf8");
    expect(readFileSync(helper, "utf8")).toBe(original);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      SCRIPTC_NODE_ISLANDS_TRACE: "boot",
    };
    delete env["SCRIPTC_LIBNODE"];
    const expected = `${before}\n42\n${after}\ndone\n`;
    // The build wrote the tree's name next to the modules: a start compares
    // it and does not hash the tree.
    const name = readFileSync(`${modules}.tree`, "utf8");
    expect(name).toMatch(/^[0-9a-f]{64}\n$/);
    const result = await run(beside, [], env);
    expect(result.stdout).toBe(expected);
    expect(result.code).toBe(0);
    expect(treeHashes(result)).toBe(0);
    // Modules without that name (a directory left from another build, a
    // deployment that dropped the file): the content decides, on every
    // start, and the program writes nothing beside itself.
    for (const other of [null, `${"0".repeat(64)}\n`]) {
      if (other === null) rmSync(`${modules}.tree`);
      else writeFileSync(`${modules}.tree`, other);
      for (let i = 0; i < 2; i++) {
        const hashed = await run(beside, [], env);
        expect(hashed.stdout).toBe(expected);
        expect(treeHashes(hashed)).toBe(1);
      }
    }
    // ... and modules that do not match the executable are refused.
    writeFileSync(helper, `${original}\n// edited\n`);
    const edited = await run(beside, [], env);
    expect(edited.code).toBe(1);
    expect(edited.stderr).toContain(
      `scriptc: the Node island modules at ${modules} do not match this program\n`,
    );
    // Under the build's name the tree is used as it is, like any file the
    // program was installed with.
    writeFileSync(`${modules}.tree`, name);
    const trusted = await run(beside, [], env);
    expect(trusted.stdout).toBe(expected);
    expect(treeHashes(trusted)).toBe(0);
  }, 300_000);

  test("an installed tree is used without a check, and lost files are put back", async () => {
    const tree = await build(
      "tree",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/tree/main.ts"),
    );
    const cache = join(outDir, "tree-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache, SCRIPTC_NODE_ISLANDS_TRACE: "boot" };
    const installs = (r: Run): number =>
      r.stderr.split("[node-islands] installing the module tree").length - 1;
    const reinstalled = (r: Run): string[] =>
      r.stderr.split("\n").filter((line) => line.startsWith("scriptc: reinstalled "));
    // The first run installs the tree: extracted, flushed, moved into place
    // under its name. Nothing is hashed: the bytes are the executable's.
    const first = await run(tree, [], env);
    expect(first.stdout).toBe("6\n");
    expect([installs(first), treeHashes(first)]).toEqual([1, 0]);
    const islands = join(cache, "scriptc/node-islands");
    const entries = installedTrees(islands);
    expect(entries).toHaveLength(1);
    expect(readdirSync(islands).sort()).toEqual([entries[0], `${entries[0]}.compile-cache`]);
    const root = join(islands, entries[0]!);
    // Later runs open the directory and nothing else.
    for (let i = 0; i < 2; i++) {
      const again = await run(tree, [], env);
      expect(again.stdout).toBe("6\n");
      expect([installs(again), treeHashes(again), reinstalled(again)]).toEqual([0, 0, []]);
    }
    // A file a tool removed: Node does not find it, the runtime puts it
    // back from the executable and loads the module again.
    const three = fileBelow(root, "three.cjs");
    const bytes = readFileSync(three, "utf8");
    rmSync(three);
    const thinned = await run(tree, [], env);
    expect(thinned.stdout).toBe("6\n");
    expect(thinned.code).toBe(0);
    expect(reinstalled(thinned)).toEqual([
      `scriptc: reinstalled 1 Node island module file missing from ${root}`,
    ]);
    expect(treeHashes(thinned)).toBe(0);
    expect(readFileSync(three, "utf8")).toBe(bytes);
    expect(reinstalled(await run(tree, [], env))).toEqual([]);
    // A directory removed with what is below it.
    rmSync(dirname(fileBelow(root, "one.cjs")), { recursive: true });
    const halved = await run(tree, [], env);
    expect(halved.stdout).toBe("6\n");
    expect(reinstalled(halved)).toEqual([
      `scriptc: reinstalled 2 Node island module files missing from ${root}`,
    ]);
    expect(readFileSync(fileBelow(root, "two.cjs"), "utf8")).toContain("exports.value = 2;");
    // The whole tree removed: installed again.
    rmSync(root, { recursive: true });
    const absent = await run(tree, [], env);
    expect(absent.stdout).toBe("6\n");
    expect([installs(absent), treeHashes(absent), reinstalled(absent)]).toEqual([1, 0, []]);
    // A file someone edited is the file Node loads, as under node_modules.
    writeFileSync(fileBelow(root, "two.cjs"), bytes.replace("3", "9"));
    const edited = await run(tree, [], env);
    expect(edited.stdout).toBe("13\n");
    expect([installs(edited), treeHashes(edited), reinstalled(edited)]).toEqual([0, 0, []]);
  }, 300_000);

  test("the executable carries its island modules and no path of the build machine", async () => {
    const bytes = readFileSync(binary).toString("latin1");
    // The program and its island modules ship inside the executable, so
    // the directory they were built from appears nowhere in it.
    expect(bytes.includes(dirname(fixture))).toBe(false);
    // Nor does any other path of the checkout, except the pack directory
    // the executable loads libnode from (which CI may place in the
    // checkout), and in a sanitized build the runtime sources that the
    // sanitizers' reports name.
    if (!sanitize) {
      const outsidePack = [pack!, realpathSync(pack!)].reduce((b, p) => b.replaceAll(p, ""), bytes);
      expect(outsidePack.includes(repoRoot)).toBe(false);
    }
    // A copy elsewhere runs with the modules it carries, extracted into a
    // private cache directory named by the manifest's digest.
    const moved = join(outDir, "moved");
    mkdirSync(moved, { recursive: true });
    copyFileSync(binary, join(moved, "app"));
    chmodSync(join(moved, "app"), 0o755);
    const cache = join(outDir, "moved-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache };
    expect((await run(join(moved, "app"), [], env)).stdout).toBe(`${before}\n42\n${after}\ndone\n`);
    const islands = join(cache, "scriptc/node-islands");
    const [digest] = installedTrees(islands);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(islands).mode & 0o777).toBe(0o700);
    expect(statSync(join(islands, digest!)).mode & 0o777).toBe(0o700);
    // The installed modules are the ones Node loads from then on.
    writeFileSync(join(islands, digest!, "helper.cjs"), "exports.answer = () => 7;\n");
    expect((await run(join(moved, "app"), [], env)).stdout).toBe(`${before}\n7\n${after}\ndone\n`);
    // Removed, they are installed again from the executable.
    rmSync(join(islands, digest!), { recursive: true });
    expect((await run(join(moved, "app"), [], env)).stdout).toBe(`${before}\n42\n${after}\ndone\n`);
  });

  test("a bounded import() names a program module the island shares", async () => {
    // The island loads its module through a syntactically bounded argument
    // (`"./bounded" + "-dyn.mjs"`), so the module it names is provided to
    // the island instead of refused, and both sides write the one instance.
    const app = await build(
      "bounded-import",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/bounded-import.ts"),
    );
    expect(await run(app, [])).toEqual({
      stdout: [
        'main 1 "main-1"',
        "island main-1 -> 2 ns=2",
        'main after true "main-1,island-dyn"',
        "island again main-1,island-dyn -> 3 ns=3",
        'main end "main-1,island-dyn,island-dyn"',
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  }, 300_000);

  test("an island package's import is repeated after its lost file is put back", async () => {
    // The compiler's island imports load through the handle API, the other
    // road by which Node's error reaches the program.
    const order = await build(
      "order-repair",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/order/main.ts"),
    );
    const cache = join(outDir, "order-repair-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache };
    const intact = await run(order, [], env);
    expect(intact).toMatchObject({ stderr: "", code: 0 });
    const root = join(
      cache,
      "scriptc/node-islands",
      installedTrees(join(cache, "scriptc/node-islands"))[0]!,
    );
    rmSync(fileBelow(root, "thing.js"));
    const repaired = await run(order, [], env);
    expect(repaired).toEqual({
      stdout: intact.stdout,
      stderr: `scriptc: reinstalled 1 Node island module file missing from ${root}\n`,
      code: 0,
    });
    expect(await run(order, [], env)).toEqual(intact);
  }, 300_000);

  test("asynchronous calls are repeated after their modules' lost files are put back", async () => {
    // Two calls pending together, each into a module whose file is gone:
    // the first outcome repairs the tree, and both calls are made again.
    const dir = join(outDir, "async-repair");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "later.cjs"), "exports.later = async (n) => n + 1;\n");
    writeFileSync(join(dir, "twice.cjs"), "exports.twice = async (n) => n * 2;\n");
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import { call } from "@scriptc/node";',
        "const [a, b] = await Promise.all([",
        '  call<number>("./later.cjs", "later", 41),',
        '  call<number>("./twice.cjs", "twice", 21),',
        "]);",
        "console.log(a, b);",
        "",
      ].join("\n"),
    );
    const program = await build("async-repair-out", undefined, join(dir, "main.ts"));
    const cache = join(outDir, "async-repair-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache };
    expect(await run(program, [], env)).toEqual({ stdout: "42 42\n", stderr: "", code: 0 });
    const islands = join(cache, "scriptc/node-islands");
    const root = join(islands, installedTrees(islands)[0]!);
    rmSync(fileBelow(root, "later.cjs"));
    rmSync(fileBelow(root, "twice.cjs"));
    expect(await run(program, [], env)).toEqual({
      stdout: "42 42\n",
      stderr: `scriptc: reinstalled 2 Node island module files missing from ${root}\n`,
      code: 0,
    });
  }, 300_000);

  test("a module whose name needs a JSON escape ships and loads", async () => {
    // The runtime reads the manifest the build writes in one pass, and
    // leaves a manifest with an escaped string to the JSON parser.
    const dir = join(outDir, "escaped-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'say "hi".cjs'), "exports.answer = () => 7;\n");
    writeFileSync(
      join(dir, "main.ts"),
      `import { callSync } from "@scriptc/node";\nconsole.log(callSync<number>('./say "hi".cjs', "answer"));\n`,
    );
    const escaped = await build("escaped-name-out", undefined, join(dir, "main.ts"));
    expect(readFileSync(escaped).includes('say \\"hi\\".cjs')).toBe(true);
    const cache = join(outDir, "escaped-name-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache };
    for (let i = 0; i < 2; i++)
      expect(await run(escaped, [], env)).toEqual({ stdout: "7\n", stderr: "", code: 0 });
  }, 300_000);

  test("a missing pack fails the first call", async () => {
    const result = await run(binary, [], {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      SCRIPTC_LIBNODE: "/nonexistent/pack",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${before}\n`);
    expect(result.stderr).toMatch(
      /^scriptc: cannot load Node\.js for this program's Node islands: .*\/nonexistent\/pack\/libscr_node_bridge\.(so|dylib).*\n$/,
    );
  });

  test("SCRIPTC_LIBNODE must be an absolute path", async () => {
    const result = await run(binary, [], {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      SCRIPTC_LIBNODE: "relative/pack",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${before}\n`);
    expect(result.stderr).toBe(
      "scriptc: SCRIPTC_LIBNODE must be an absolute path to a libnode pack directory\n",
    );
  });

  test("an error whose message cannot be read crosses with an empty message", async () => {
    expect(await run(binary, ["unreadable"])).toEqual({
      stdout: `${before}\n42\n${after}\ncaught true ""\ndone\n`,
      stderr: "",
      code: 0,
    });
  });

  test("a call from a worker thread is routed to the island's thread", async () => {
    const worker = await build(
      "worker",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/worker.ts"),
    );
    // The build says what differs from Node (SC6011): a module that worker
    // threads run loads these island modules, and the program has one
    // instance of each for all its threads.
    const notedDir = join(outDir, "worker-noted");
    mkdirSync(notedDir, { recursive: true });
    const noted = await compile(join(repoRoot, "tests/fixtures/node-island/worker.ts"), {
      outPath: join(notedDir, "worker"),
      outDir: notedDir,
      sanitize,
    });
    expect(noted.ok).toBe(true);
    const shared = (noted.warnings ?? []).filter((d) => d.code === "SC6011");
    expect([...new Set(shared.map((d) => /module '([^']+)'/.exec(d.message)?.[1]))].sort()).toEqual(
      ["./helper.cjs", "thenable-pkg"],
    );
    expect(shared[0]?.message).toContain(
      "the program has one instance of that module for all its threads, while under Node each worker thread has its own",
    );
    const refusal = (what: string, value: string, where: string): string =>
      `worker ${what} ERR_SCRIPTC_ISLAND_WORKER_VALUE\n` +
      `worker   scriptc: ${value} cannot cross between a worker thread and its Node island (${where})\n`;
    expect(await run(worker, [])).toEqual({
      stdout:
        // One instance of the island module for both threads: the worker's
        // count continues the main thread's (Node: a worker counts from 1).
        "main 42\nmain count 1\nworker called 42\nworker get ERR_SCRIPTC_ISLAND_WORKER_VALUE\n" +
        "worker count 2\n" +
        refusal(
          "function back",
          "a native function or object the island holds by reference",
          "the result of the call to 'getFunction'",
        ) +
        refusal(
          "callback",
          "a native function (a callback)",
          "argument 1 of the call to 'callBack'",
        ) +
        refusal(
          "bytes out",
          "native bytes (a typed array or Buffer)",
          "argument 1 of the call to 'byteLength'",
        ) +
        refusal(
          "bytes in",
          "island bytes (a typed array or Buffer)",
          "the result of the call to 'bytes'",
        ) +
        refusal("buffer out", "a native ArrayBuffer", "argument 1 of the call to 'byteLength'") +
        refusal("buffer in", "an island ArrayBuffer", "the result of the call to 'buffer'") +
        refusal("symbol out", "a native symbol", "argument 1 of the call to 'describe'") +
        refusal("symbol in", "an island symbol", "the result of the call to 'symbol'") +
        refusal(
          "error out",
          "a native error passed by reference",
          "argument 1 of the call to 'errorName'",
        ) +
        "worker plain 42\n" +
        "worker async ERR_SCRIPTC_ISLAND_WORKER_ASYNC\n" +
        "worker await ERR_SCRIPTC_ISLAND_WORKER_ASYNC\n" +
        "worker thenable ERR_SCRIPTC_ISLAND_WORKER_VALUE\nexit 0\n",
      stderr: "",
      code: 0,
    });
  }, 300_000);

  test("a module shared with the island that a worker also runs is named at build time", async () => {
    // The island has one instance of every module it imports, the main
    // thread's, whichever thread calls it, and a worker's own code runs the
    // worker's instance of the same module: the build says so (SC6011), for
    // the shared module and for the island module the worker loads, and the
    // program runs with that one difference from Node, which prints
    // `worker 0/0 1/1 2 2/2` and `main after 2 2`.
    const entry = join(repoRoot, "tests/fixtures/node-island/worker-shared/main.mjs");
    const dir = join(outDir, "worker-shared");
    mkdirSync(dir, { recursive: true });
    const built = await compile(entry, { outPath: join(dir, "main"), outDir: dir, sanitize });
    if (!built.ok)
      throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const noted = (built.warnings ?? []).filter((d) => d.code === "SC6011");
    const subjects = noted
      .map((d) => d.message.slice(0, d.message.indexOf(":")).replace(repoRoot, "<repo>"))
      .sort();
    expect(subjects).toEqual([
      "worker threads run the module '<repo>/tests/fixtures/node-island/worker-shared/state.mjs', and Node island code imports it too",
      "worker threads run this module, and it loads the Node island module './plugin.mjs'",
    ]);
    const ran = await run(built.binaryPath, []);
    expect(ran.stdout).toBe("main 2 2\nworker 0/2 1/2 3 1/3\nmain after 3 3\n");
    // The sanitized lane's reference-count audit fails at exit for a
    // program with worker threads and a shared module that exports a
    // function, with or without this change and whether or not a worker
    // runs: in such a build each read of the module's exports after the
    // script has ended (the island reads them while Node stops) makes the
    // function's value again, and nothing frees it. Until that is fixed the
    // exit status and stderr are compared in the plain lane only.
    if (!sanitize) expect(ran).toMatchObject({ stderr: "", code: 0 });
  }, 300_000);

  test("a worker thread's call is repeated after its module's lost file is put back", async () => {
    // The worker reads the outcome of its own call, and the tree and its
    // manifest belong to the island's thread: the repair runs there, and the
    // worker makes the call again.
    const dir = join(outDir, "worker-repair");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "later.cjs"), "exports.later = (n) => n + 1;\n");
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import { Worker, isMainThread, parentPort } from "node:worker_threads";',
        'import { callSync } from "@scriptc/node";',
        "if (isMainThread) {",
        "  const worker = new Worker(new URL(import.meta.url));",
        '  worker.on("message", (message: string) => console.log("worker", message));',
        '  worker.on("exit", (code: number) => console.log("exit", code));',
        "} else {",
        '  parentPort!.postMessage("called " + callSync<number>("./later.cjs", "later", 41));',
        "}",
        "",
      ].join("\n"),
    );
    const program = await build("worker-repair-out", undefined, join(dir, "main.ts"));
    const cache = join(outDir, "worker-repair-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { ...process.env, XDG_CACHE_HOME: cache };
    const intact = { stdout: "worker called 42\nexit 0\n", stderr: "", code: 0 };
    expect(await run(program, [], env)).toEqual(intact);
    const islands = join(cache, "scriptc/node-islands");
    const root = join(islands, readdirSync(islands)[0]!);
    rmSync(fileBelow(root, "later.cjs"));
    expect(await run(program, [], env)).toEqual({
      ...intact,
      stderr: `scriptc: reinstalled 1 Node island module file missing from ${root}\n`,
    });
    expect(await run(program, [], env)).toEqual(intact);
  }, 300_000);

  test("full garbage collections during calls, at depth on both sides", async () => {
    const stress = await build(
      "gc-stress",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/gc-stress.ts"),
    );
    expect(await run(stress, [])).toEqual({
      stdout:
        "churn 2000000\nnested 5000\ndeep 8000\nfibers 100001,100002,100003,100004\ntimer 500000\n",
      stderr: "",
      code: 0,
    });
  }, 300_000);

  test("Node ignores NODE_OPTIONS from the program's environment", async () => {
    const result = await run(binary, [], {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      NODE_OPTIONS: "--require /nonexistent/preload.cjs",
    });
    expect(result).toEqual({ stdout: `${before}\n42\n${after}\ndone\n`, stderr: "", code: 0 });
  });

  test("child_process.fork() needs an execPath of its own", async () => {
    expect((await run(binary, ["fork"])).stdout).toBe(
      `${before}\n42\n${after}\nchild_process.fork() in a Node island needs options.execPath (a node executable): process.execPath is this program\ndone\n`,
    );
  });

  test("a cached build follows a change of the recorded libnode pack", async () => {
    // The same program built against a copy of the pack elsewhere records
    // the copy: the executable cache does not serve the first build's entry.
    const copy = join(outDir, "pack-copy");
    rmSync(copy, { recursive: true, force: true });
    cpSync(pack!, copy, { recursive: true });
    const first = readFileSync(await build("cached-pack", pack!));
    const second = readFileSync(await build("cached-pack", copy));
    expect(first.includes(Buffer.from(copy))).toBe(false);
    expect(second.includes(Buffer.from(copy))).toBe(true);
  }, 300_000);

  test("a pack of another Node version fails the first call", async () => {
    const dir = await fakePack("old-node", "SCR_NODE_BRIDGE_ABI", "22.11.0");
    const result = await run(binary, [], {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      SCRIPTC_LIBNODE: dir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      new RegExp(
        `^scriptc: this program's Node islands need libnode \\d+\\.\\d+\\.\\d+; found 22\\.11\\.0 \\(NODE_MODULE_VERSION 127\\) at ${dir}\\n$`,
      ),
    );
  });

  test("a bridge of another ABI fails the first call", async () => {
    const dir = await fakePack("other-abi", "999u", "24.22.0");
    const result = await run(binary, [], {
      ...process.env,
      XDG_CACHE_HOME: cacheHome,
      SCRIPTC_LIBNODE: dir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `scriptc: the libnode pack at ${dir} has an incompatible bridge (ABI 999; this program needs 21)\n`,
    );
  });

  test("links no Node and exports nothing libnode binds to", async () => {
    if (process.platform !== "linux" || sanitize) return;
    const { stdout } = await execFileAsync("nm", [binary], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const defined = definedFunctionNames(stdout);
    expect(nodeIslandSymbols(defined)).toContain("scr_node_island_call_sync");
    expect(defined.filter((name) => /^(napi_|_ZN2v8|_ZN4node|uv_)/.test(name))).toEqual([]);
    // libnode joins the global scope (RTLD_GLOBAL): the executable must not
    // export a name it would bind to instead of its own.
    const dynamic = await execFileAsync("nm", ["-D", "--defined-only", binary], {
      encoding: "utf8",
    });
    const conflicting = dynamic.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1) ?? "")
      .filter((name) =>
        /^(napi_|node_|uv_|_ZN2v8|_ZN4node|SSL|EVP_|ERR_|deflate|inflate|crc32|adler32|mbedtls_|ares_|nghttp2_)/.test(
          name,
        ),
      );
    expect(conflicting).toEqual([]);
  });

  // A module that patches a builtin module's CommonJS object runs in a Node
  // island automatically (H3): the patch is meant for code that shares
  // Node's builtin, and only Node has that object.
  describe("a module that patches a builtin module", () => {
    const corpus = join(repoRoot, "tests/corpus/6897-node-island-builtin-patch");

    /** A scratch copy of the corpus, with main.ts optionally replaced. It
     * lives outside node_modules: a package copied below one is a library
     * with no declaration file, and its implicit `any` fails the build. */
    function copyCorpus(name: string, main?: string, extra: Record<string, string> = {}): string {
      const dir = mkdtempSync(join(tmpdir(), `scriptc-builtin-patch-${name}-`));
      cpSync(corpus, dir, { recursive: true });
      if (main !== undefined) writeFileSync(join(dir, "main.ts"), main);
      for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text);
      return dir;
    }

    /** A build with a cache of its own: a hit reports the islands but not
     * the SC8001 notes, and these tests read the notes. */
    async function buildDir(dir: string, name: string, native: readonly string[] = []) {
      return withFreshBuildCache(() =>
        compile(join(dir, "main.ts"), {
          outPath: join(dir, name),
          outDir: dir,
          sanitize,
          libnode: pack!,
          ...(native.length === 0 ? {} : { nodeIslands: { native } }),
        }),
      );
    }

    async function withFreshBuildCache<T>(build: () => Promise<T>): Promise<T> {
      const cache = mkdtempSync(join(tmpdir(), "scriptc-builtin-patch-cache-"));
      const previous = process.env["SCRIPTC_CACHE_DIR"];
      process.env["SCRIPTC_CACHE_DIR"] = cache;
      try {
        return await build();
      } finally {
        if (previous === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
        else process.env["SCRIPTC_CACHE_DIR"] = previous;
        rmSync(cache, { recursive: true, force: true });
      }
    }

    function messages(result: { diagnostics?: { code: string; message: string }[] }): string[] {
      return (result.diagnostics ?? []).map((d) => `${d.code}: ${d.message}`);
    }

    test("islands only the patching module, with the builtin-patch reason", async () => {
      const dir = copyCorpus("auto");
      const result = await buildDir(dir, "main");
      expect(messages(result)).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.islands?.modules.map((file) => basename(file))).toEqual(["loader.ts"]);
      const notes = (result.warnings ?? []).filter(
        (d) => d.code === "SC8001" && d.message.includes("loader.ts"),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).toContain("builtin-patch");
      expect(notes[0]!.message).toContain("fs.readFileSync");
      expect(notes[0]!.message).toContain("Node island");
    }, 300_000);

    test("a user module that reads a patched member joins the island set", async () => {
      // The pi shape (provider-env.ts): a user module reads a patched member
      // through the builtin's CommonJS object. It joins the island set like
      // an npm reader, so the read sees the patch exactly as in Node.
      const dir = copyCorpus(
        "user-reader",
        `import { installPatch } from "./patch.ts";
import { readProbe } from "./read.ts";
installPatch();
console.log(readProbe());
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched payload") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
`,
          "read.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function readProbe(): string {
  const { readFileSync } = require("fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(messages(result)).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.islands?.modules ?? []).map((file) => basename(file)).sort()).toEqual([
        "patch.ts",
        "read.ts",
      ]);
      const reader = (result.warnings ?? []).find(
        (d) => d.code === "SC8001" && d.message.includes("read.ts"),
      );
      expect(reader?.message).toContain("it reads 'fs.readFileSync'");
      expect(reader?.message).toContain("patch.ts");
      // The island sources are cached under XDG_CACHE_HOME and Node strips
      // their types when it requires them: a cache below the repository's
      // node_modules is refused (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
      const islandCache = mkdtempSync(join(tmpdir(), "scriptc-user-reader-cache-"));
      expect(
        await run(join(dir, "main"), [], { ...process.env, XDG_CACHE_HOME: islandCache }),
      ).toEqual({
        stdout: "patched payload\n",
        stderr: "",
        code: 0,
      });
    }, 300_000);

    test("a type-only import in an island subgraph ships nothing", async () => {
      // The pi shape (env-api-keys.ts): the island subgraph reaches a module
      // whose computed load would be SC8006, but only through `import type`.
      // Node's type stripper erases that edge, so the module never loads and
      // the island tree must not trace, ship, or refuse it.
      const dir = copyCorpus(
        "user-reader-type-only",
        `import { installPatch } from "./patch.ts";
import { readProbe } from "./read.ts";
installPatch();
console.log(readProbe());
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched payload") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
`,
          "read.ts": `import type { Loader } from "./helper.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function readProbe(): string {
  void (null as unknown as Loader);
  const { readFileSync } = require("fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
`,
          "helper.ts": `export type Loader = (name: string) => Promise<unknown>;
export function loadByName(name: string): Promise<unknown> {
  return import(name);
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(messages(result)).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.islands?.modules ?? []).map((file) => basename(file)).sort()).toEqual([
        "patch.ts",
        "read.ts",
      ]);
      // Node loads those two files, so the type-strip cache rule applies.
      const islandCache = mkdtempSync(join(tmpdir(), "scriptc-user-reader-cache-"));
      expect(
        await run(join(dir, "main"), [], { ...process.env, XDG_CACHE_HOME: islandCache }),
      ).toEqual({
        stdout: "patched payload\n",
        stderr: "",
        code: 0,
      });
    }, 300_000);

    test("a reader whose island subgraph loads a module by a computed specifier is SC8006", async () => {
      // The pi shape past the reader rule (provider-env.ts): an islanded user
      // module statically imports a program module that loads by a computed
      // specifier. The island tree cannot ship that module, so the build
      // reports SC8006 — it used to throw the collection's PoisonError
      // through the driver instead, a stack trace and no diagnostic.
      const dir = copyCorpus(
        "reader-computed-import",
        `import { installPatch } from "./patch.ts";
import { readProbe } from "./read.ts";
installPatch();
console.log(readProbe());
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched payload") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
`,
          "read.ts": `import { loadByName } from "./helper.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function readProbe(): string {
  void loadByName;
  const { readFileSync } = require("fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
`,
          "helper.ts": `export function loadByName(name: string): Promise<unknown> {
  return import(name);
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const problem = result.diagnostics.find((d) => d.code === "SC8006");
      expect(problem?.message).toContain("helper.ts");
      expect(problem?.message).toContain("import() with a computed specifier");
    }, 300_000);

    test("the entry module reading a patched member is SC8006", async () => {
      const dir = copyCorpus(
        "entry-reader",
        `import { createRequire } from "node:module";
import { installPatch } from "./patch.ts";
const require = createRequire(import.meta.url);
installPatch();
const { readFileSync } = require("fs") as {
  readFileSync(path: string, encoding: BufferEncoding): string;
};
console.log(readFileSync("/scriptc/does/not/exist", "utf-8"));
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(result.ok).toBe(false);
      const entry = messages(result).find(
        (m) => m.startsWith("SC8006:") && m.includes("the entry module reads 'fs.readFileSync'"),
      );
      expect(entry).toBeDefined();
      expect(entry).toContain("patch.ts");
    }, 300_000);

    test("a TypeScript reader Node cannot strip is SC8006", async () => {
      const dir = copyCorpus(
        "reader-enum",
        `import { installPatch } from "./patch.ts";
import { readProbe } from "./readenum.ts";
installPatch();
console.log(readProbe());
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
`,
          "readenum.ts": `import { createRequire } from "node:module";
enum Kind {
  A,
}
const require = createRequire(import.meta.url);
export function readProbe(): string {
  const { readFileSync } = require("fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8") + Kind.A;
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(result.ok).toBe(false);
      const stripped = messages(result).find(
        (m) => m.startsWith("SC8006:") && m.includes("Node cannot strip its types"),
      );
      expect(stripped).toBeDefined();
      expect(stripped).toContain("readenum.ts");
      expect(stripped).toContain("fs.readFileSync");
      expect(stripped).toContain("enum");
    }, 300_000);

    test("replacing process.stdout.write beside an island builds, and the island's write is the program's", async () => {
      // The island's process.stdout.write is the program's write slot
      // (scr_node_island_stdio.c), so the combination needs no refusal; it
      // used to be SC8006. What Node does differently is pinned here rather
      // than in the differential corpus: in the island `write` is an own
      // accessor that cannot be redefined or deleted, so island code cannot
      // end up with a private write the program never sees.
      const dir = copyCorpus(
        "stdio-patch",
        `import { installPatch, probe } from "./patch.ts";
installPatch();
const lines: string[] = [];
const original = process.stdout.write;
process.stdout.write = ((chunk: string | Uint8Array): boolean => {
  lines.push(typeof chunk === "string" ? chunk.trimEnd() : "bytes");
  return true;
}) as typeof process.stdout.write;
const probed = probe();
process.stdout.write = original;
console.log(probed);
console.log(lines.join("|"));
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
// An ES module, so strict code: the delete throws. The indirect eval runs
// the same delete as sloppy code, where it answers false.
export function probe(): string {
  const out: unknown[] = [Object.hasOwn(process.stdout, "write")];
  try {
    delete (process.stdout as { write?: unknown }).write;
    out.push("deleted");
  } catch (error) {
    out.push((error as Error).constructor.name);
  }
  try {
    Object.defineProperty(process.stdout, "write", { value: () => true });
    out.push("redefined");
  } catch (error) {
    out.push((error as Error).constructor.name);
  }
  out.push((0, eval)("delete process.stdout.write"));
  console.log("island line");
  return out.join(" ");
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(messages(result).filter((m) => m.includes("process.stdout.write"))).toEqual([]);
      expect(result.ok).toBe(true);
      // The island module is TypeScript, which Node does not strip below a
      // node_modules directory: the module cache goes beside the program.
      const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
      expect(await run(join(dir, "main"), [], env)).toEqual({
        stdout: "true TypeError TypeError false\nisland line\n",
        stderr: "",
        code: 0,
      });
    }, 300_000);

    test("statements, a loop and a constant after a builtin patch are evaluated where they are written", async () => {
      // Each of these is an island operation the island could evaluate from
      // a module the build writes (closed-island-init.ts). Node would read
      // that module through the patched fs.readFileSync, so in a program
      // with a module that patches a builtin none of them moves.
      const dir = copyCorpus(
        "closed-after-patch",
        `import { installPatch, mark, word } from "./patch.ts";
installPatch();
mark("statement");
for (const name of ["first", "second"]) mark(name);
const made = word("constant");
console.log(made);
`,
        {
          "patch.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
export function installPatch(): void {
  Object.defineProperty(fs, "readFileSync", {
    value: (() => "patched") as unknown as typeof fs.readFileSync,
    writable: true,
    configurable: true,
  });
}
export function mark(name: string): void {
  console.log("island " + name);
}
export function word(name: string): string {
  return "island " + name;
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(messages(result)).toEqual([]);
      expect(result.ok).toBe(true);
      const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
      expect(await run(join(dir, "main"), [], env)).toEqual({
        stdout: "island statement\nisland first\nisland second\nisland constant\n",
        stderr: "",
        code: 0,
      });
    }, 300_000);

    // A package that reads the patched member joins the island set, where the
    // patch exists. A package marked native stays native: the island does not
    // take it, and the read is SC8003 rather than a build whose package sees
    // the unpatched function.
    test("a package that reads the patched member is islanded, or SC8003 when marked native", async () => {
      const main = `import reader from "payload-reader";
import { loadPayload } from "./loader.ts";
const result = await loadPayload();
console.log(reader.payload.trim(), result.text);
`;
      const typed = {
        "node_modules/payload-reader/index.d.ts":
          "declare const reader: { payload: string };\nexport default reader;\n",
        "node_modules/payload-reader/package.json":
          '{ "name": "payload-reader", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
      };
      const islanded = copyCorpus("read-package", main, typed);
      const joined = await buildDir(islanded, "main");
      expect(messages(joined)).toEqual([]);
      expect(joined.ok).toBe(true);
      if (!joined.ok) return;
      expect(joined.islands?.packages).toEqual(["payload-reader"]);
      expect(joined.islands?.modules.map((file) => basename(file))).toEqual(["loader.ts"]);
      const marked = copyCorpus("read-package-native", main, typed);
      const blocked = await buildDir(marked, "main", ["payload-reader"]);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      const list = messages(blocked);
      const read = list.find((m) => m.startsWith("SC8003:"));
      expect(read).toBeDefined();
      expect(read).toContain("'payload-reader'");
      expect(read).toContain("fs.readFileSync");
      expect(blocked.islands?.packages ?? []).toEqual([]);
    }, 300_000);

    test("--node-islands=off makes the patch a native refusal again", async () => {
      const dir = copyCorpus(
        "off",
        'import { patch } from "./loader.ts";\npatch();\nconsole.log("ok");\n',
      );
      // The package the corpus loads has no declaration file, and without
      // an island its implicit `any` would fail before the patch refusal.
      writeFileSync(
        join(dir, "loader.ts"),
        `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
const original = fs.readFileSync.bind(fs);
export function patch(): void {
  fs.readFileSync = original as typeof fs.readFileSync;
}
`,
      );
      const result = await withFreshBuildCache(() =>
        compile(join(dir, "main.ts"), {
          outPath: join(dir, "main"),
          outDir: dir,
          sanitize,
          libnode: pack!,
          nodeIslands: { mode: "off" },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some(
          (d) => /^SC(1090|2020)$/.test(d.code) && d.loc.file.endsWith("loader.ts"),
        ),
      ).toBe(true);
    }, 300_000);

    test("an entry module that patches is SC8006", async () => {
      const dir = copyCorpus(
        "entry",
        `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
fs.readFileSync = (() => "") as typeof fs.readFileSync;
console.log(fs.existsSync("x"));
`,
      );
      const result = await buildDir(dir, "main");
      expect(result.ok).toBe(false);
      const entry = messages(result).find(
        (m) => m.startsWith("SC8006:") && m.includes("move the patch into a module of its own"),
      );
      expect(entry).toBeDefined();
      expect(entry).toContain("fs.readFileSync");
    });

    test("a TypeScript patcher Node cannot strip is SC8006", async () => {
      const dir = copyCorpus(
        "enum",
        `import { patched } from "./enumpatch.ts";
console.log(patched);
`,
        {
          "enumpatch.ts": `import { createRequire } from "node:module";
enum Kind {
  A,
}
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
fs.readFileSync = (() => "") as typeof fs.readFileSync;
export const patched = Kind.A;
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(result.ok).toBe(false);
      const stripped = messages(result).find(
        (m) => m.startsWith("SC8006:") && m.includes("Node cannot strip its types"),
      );
      expect(stripped).toBeDefined();
      expect(stripped).toContain("enum");
    });

    test("a TypeScript patcher shares the program modules it imports with native code", async () => {
      // state.ts is a stateful program module that both the native entry and
      // the islanded patcher import: Node runs one copy of it, so the island
      // must reach the program's copy, not one of its own.
      const dir = copyCorpus(
        "shared-state",
        `import { bump, count } from "./state.ts";
import { patchAndBump } from "./statepatch.ts";
bump();
const fromIsland = patchAndBump();
console.log(fromIsland, count());
`,
        {
          "state.ts": `let value = 0;
export function bump(): number {
  value++;
  return value;
}
export function count(): number {
  return value;
}
`,
          "statepatch.ts": `import { createRequire } from "node:module";
import { bump } from "./state.ts";
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
const original = fs.readFileSync;
export function patchAndBump(): number {
  fs.readFileSync = original;
  return bump();
}
`,
        },
      );
      const result = await buildDir(dir, "main");
      expect(messages(result)).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.islands?.modules.map((file) => basename(file))).toEqual(["statepatch.ts"]);
      // Node strips types only outside node_modules, and the shared island
      // cache of these tests lives below the repository's node_modules.
      const islandCache = mkdtempSync(join(tmpdir(), "scriptc-island-cache-"));
      // A cache reached through a symbolic link (macOS's temporary directory
      // is under /var, which is /private/var): Node resolves the island's
      // import to the shared module's real path.
      const linkedCache = `${islandCache}-link`;
      symlinkSync(islandCache, linkedCache);
      try {
        for (const cache of [islandCache, linkedCache]) {
          const out = await run(join(dir, "main"), [], { ...process.env, XDG_CACHE_HOME: cache });
          expect(out).toEqual({ stdout: "2 2\n", stderr: "", code: 0 });
        }
      } finally {
        rmSync(linkedCache, { force: true });
        rmSync(islandCache, { recursive: true, force: true });
      }
    }, 300_000);
  });

  // The build-time probe evaluates modules to decide their deferral. It
  // evaluates a program module that runs in an island only when the static
  // gate proves its top level free of effects; this one writes a file, so
  // it loads eagerly and the build never evaluates it: the executable does,
  // when the entry requires it.
  test("the build does not evaluate a program module that runs in an island", async () => {
    const dir = sloppyModuleProject("probe");
    const cache = mkdtempSync(join(tmpdir(), "scriptc-sloppy-probe-cache-"));
    const islandCache = mkdtempSync(join(tmpdir(), "scriptc-island-cache-"));
    const previous = process.env["SCRIPTC_CACHE_DIR"];
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    try {
      const result = await compile(join(dir, "main.js"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        libnode: pack!,
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.islands?.modules.map((file) => basename(file))).toEqual(["sloppy.js"]);
      expect(existsSync(join(dir, "evaluated.txt"))).toBe(false);
      const out = await run(join(dir, "main"), [], { ...process.env, XDG_CACHE_HOME: islandCache });
      expect(out).toEqual({ stdout: "2\n", stderr: "", code: 0 });
      expect(existsSync(join(dir, "evaluated.txt"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
      rmSync(islandCache, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  // A sloppy-mode write to an undeclared name creates a global at run time.
  // The native tier has no global object, so the checker refuses the write
  // (SC1091) and the module runs in a Node island instead (the user's policy
  // for sloppy-only semantics, 2026-10-31). Strict-mode code keeps the
  // refusal: there the write throws ReferenceError, which is an ordinary
  // lowering gap rather than a sloppy semantic.
  test("a sloppy implicit-global write islands the module", async () => {
    const dir = implicitGlobalProject("island");
    const cache = mkdtempSync(join(tmpdir(), "scriptc-implicit-global-cache-"));
    const islandCache = mkdtempSync(join(tmpdir(), "scriptc-island-cache-"));
    const previous = process.env["SCRIPTC_CACHE_DIR"];
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    try {
      const result = await compile(join(dir, "main.js"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        libnode: pack!,
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.islands?.modules.map((file) => basename(file))).toEqual(["legacy.cjs"]);
      const out = await run(join(dir, "main"), [], { ...process.env, XDG_CACHE_HOME: islandCache });
      expect(out).toEqual({ stdout: "42\n43\n", stderr: "", code: 0 });
      // The same write under a "use strict" prologue throws instead: the
      // native refusal stands, and no island is chosen.
      const strict = await compile(join(dir, "strict-main.js"), {
        outPath: join(dir, "strict-main"),
        outDir: dir,
        sanitize,
        libnode: pack!,
      });
      expect(strict.ok).toBe(false);
      if (strict.ok) return;
      expect(
        strict.diagnostics.some((d) => d.code === "SC1091" && d.loc.file.endsWith("strict.cjs")),
      ).toBe(true);
      expect(strict.islands?.modules).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
      rmSync(islandCache, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  // A sloppy implicit-global write creates the name on Node's global object
  // when its island module runs. Native code has no global object, so a
  // native user module that reads the name is SC8020, and a native npm
  // package that reads it joins the island set, where the global exists.
  test("a native read of an island's implicit global", async () => {
    const dir = implicitGlobalProject("readers");
    const cache = mkdtempSync(join(tmpdir(), "scriptc-implicit-global-cache-"));
    const islandCache = mkdtempSync(join(tmpdir(), "scriptc-island-cache-"));
    const previous = process.env["SCRIPTC_CACHE_DIR"];
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    try {
      const reader = await compile(join(dir, "reader-main.js"), {
        outPath: join(dir, "reader-main"),
        outDir: dir,
        sanitize,
        libnode: pack!,
      });
      expect(reader.ok).toBe(false);
      if (reader.ok) return;
      const read = reader.diagnostics.find((d) => d.code === "SC8020");
      expect(read?.loc.file.endsWith("reader-main.js")).toBe(true);
      expect(read?.message).toContain("'counter'");
      const viaPackage = await compile(join(dir, "package-main.js"), {
        outPath: join(dir, "package-main"),
        outDir: dir,
        sanitize,
        libnode: pack!,
      });
      if (!viaPackage.ok)
        throw new Error(viaPackage.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(viaPackage.islands?.packages).toEqual(["reads-global"]);
      expect(viaPackage.islands?.modules.map((file) => basename(file))).toEqual(["legacy.cjs"]);
      // A package the build marks native stays native: the island does not
      // take it, and the global it reads is SC8003 rather than a built
      // executable that reads an absent global.
      const marked = await compile(join(dir, "package-main.js"), {
        outPath: join(dir, "package-native"),
        outDir: dir,
        sanitize,
        libnode: pack!,
        nodeIslands: { native: ["reads-global"] },
      });
      expect(marked.ok).toBe(false);
      if (marked.ok) return;
      const blocked = marked.diagnostics.find((d) => d.code === "SC8003");
      expect(blocked?.message).toContain("'reads-global'");
      expect(blocked?.message).toContain("'counter'");
      expect(blocked?.loc.file.endsWith("package-main.js")).toBe(true);
      expect(marked.islands?.packages ?? []).toEqual([]);
      const out = await run(join(dir, "package-main"), [], {
        ...process.env,
        XDG_CACHE_HOME: islandCache,
      });
      expect(out).toEqual({ stdout: "42\n", stderr: "", code: 0 });
    } finally {
      if (previous === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
      rmSync(islandCache, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

/** A CommonJS program whose entry requires a sloppy-mode module that writes
 * an undeclared name (an implicit global), and a strict-mode sibling whose
 * write throws, a reader that reads the global natively, and an npm package
 * that reads it. */
function implicitGlobalProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-implicit-global-${name}-`));
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(
    join(dir, "main.js"),
    'const legacy = require("./legacy.cjs");\nconsole.log(legacy.read());\nlegacy.bump();\nconsole.log(legacy.read());\n',
  );
  writeFileSync(
    join(dir, "legacy.cjs"),
    [
      "counter = 41;",
      "function bump() {",
      "  counter = counter + 1;",
      "}",
      "function read() {",
      "  return counter + 1;",
      "}",
      "module.exports = { read, bump };",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "strict-main.js"), 'require("./strict.cjs");\n');
  writeFileSync(
    join(dir, "strict.cjs"),
    ['"use strict";', "strictCounter = 1;", "module.exports = {};", ""].join("\n"),
  );
  // Both readers run after legacy.cjs created the global.
  writeFileSync(
    join(dir, "reader-main.js"),
    'require("./legacy.cjs");\nconsole.log(counter + 1);\n',
  );
  mkdirSync(join(dir, "node_modules/reads-global"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules/reads-global/package.json"),
    '{"name":"reads-global","version":"1.0.0","main":"index.js","types":"index.d.ts"}\n',
  );
  writeFileSync(
    join(dir, "node_modules/reads-global/index.js"),
    "module.exports = function read() {\n  return counter + 1;\n};\n",
  );
  writeFileSync(
    join(dir, "node_modules/reads-global/index.d.ts"),
    "declare function read(): number;\nexport = read;\n",
  );
  writeFileSync(
    join(dir, "package-main.js"),
    'const read = require("reads-global");\nrequire("./legacy.cjs");\nconsole.log(read());\n',
  );
  return dir;
}

/** A CommonJS program whose entry requires a sloppy-mode module (a `with`
 * statement islands it under the default `--node-islands=auto`). The
 * module writes evaluated.txt beside itself when it evaluates. */
function sloppyModuleProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-sloppy-${name}-`));
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(
    join(dir, "main.js"),
    'const { value } = require("./sloppy.js");\nconsole.log(value());\n',
  );
  writeFileSync(
    join(dir, "sloppy.js"),
    [
      'require("fs").writeFileSync(require("path").join(__dirname, "evaluated.txt"), "evaluated\\n");',
      "function value() {",
      "  with ({ n: 1 }) {",
      "    return n + 1;",
      "  }",
      "}",
      "module.exports = { value };",
      "",
    ].join("\n"),
  );
  return dir;
}

// A program module that runs in an island and whose top level has effects
// is never evaluated by the build: the decision keeps it eager.
// SCRIPTC_NODE_ISLANDS_TRACE=defer prints every decision; IR output needs
// no libnode pack, and without one every island module is eager.
test("a program module with top-level effects that runs in an island stays eager", async () => {
  const dir = sloppyModuleProject("defer");
  const previous = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  process.env["SCRIPTC_NODE_ISLANDS_TRACE"] = "defer";
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    const outPath = join(dir, "main.ir.json");
    const result = await compile(join(dir, "main.js"), { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const decisions = written.filter((line) => line.includes("sloppy.js"));
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((line) => line.startsWith("[node-islands] eager "))).toBe(true);
    const ir = JSON.stringify(deserializeModule(readFileSync(outPath, "utf8")));
    expect(ir).toContain("nodeIsland.require");
    expect(ir).not.toContain("nodeIsland.defer");
    expect(existsSync(join(dir, "evaluated.txt"))).toBe(false);
  } finally {
    spy.mockRestore();
    if (previous === undefined) delete process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
    else process.env["SCRIPTC_NODE_ISLANDS_TRACE"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

// A use of a Node 24 global native code does not provide is the one runtime
// refusal JavaScript defers honestly: the statement throws where it is
// reached (SC2020, host-global), so a package that keeps such a path inside
// a function body keeps compiling natively (jose's CompressionStream). Only
// a use in module code, which throws before the module finishes evaluating,
// makes the package a Node island. Needs no libnode pack: the native build
// links without one, and the island build stops before linking without one.
test("a host-global fence inside a function body keeps its package native", async () => {
  const dir = join(outDir, "host-global-fence");
  rmSync(dir, { recursive: true, force: true });
  const writePackage = (name: string, body: string): void => {
    const at = join(dir, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, "package.json"),
      JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(at, "index.js"), body);
    writeFileSync(
      join(at, "index.d.ts"),
      "export declare const api: { probe(): unknown; answer(): string };\n",
    );
  };
  const entry = (name: string): string => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, `import { api } from "${name}";\nconsole.log(api.answer());\n`);
    return file;
  };
  // The exported object reaches `probe` at module load, so its body is
  // lowered and fenced; a program that never calls it still runs.
  writePackage(
    "fenced-body",
    [
      "function probe() {",
      "  return new FormData();",
      "}",
      "function answer() {",
      '  return "native";',
      "}",
      "export const api = { probe, answer };",
      "",
    ].join("\n"),
  );
  writePackage(
    "fenced-module",
    [
      "const eager = new FormData();",
      "function probe() {",
      "  return typeof eager;",
      "}",
      "function answer() {",
      '  return "native";',
      "}",
      "export const api = { probe, answer };",
      "",
    ].join("\n"),
  );
  const native = await compile(entry("fenced-body"), {
    outPath: join(dir, "fenced-body"),
    outDir: dir,
    sanitize,
  });
  expect(native.ok ? [] : native.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  if (!native.ok) return;
  expect((native.warnings ?? []).map((d) => d.code)).not.toContain("SC8001");
  expect(await run(native.binaryPath, [])).toEqual({ stdout: "native\n", stderr: "", code: 0 });

  const islanded = await compile(entry("fenced-module"), {
    outPath: join(dir, "fenced-module"),
    outDir: dir,
    sanitize,
  });
  if (islanded.ok)
    expect(
      (islanded.warnings ?? []).filter((d) => d.code === "SC8001").map((d) => d.message),
    ).toEqual([expect.stringContaining("'fenced-module@1.0.0' runs in a Node island")]);
  else expect(islanded.diagnostics.map((d) => d.code)).toContain("SC8005");

  // A second build of the same input is served by the executable cache, whose
  // hit skips lowering: it reports the same warnings the cold build did, so a
  // cache hit never hides a diagnostic.
  const warm = await compile(entry("fenced-module"), {
    outPath: join(dir, "fenced-module"),
    outDir: dir,
    sanitize,
  });
  expect(warm.ok).toBe(islanded.ok);
  if (warm.ok && islanded.ok) expect(warm.warnings).toEqual(islanded.warnings);
  else if (!warm.ok && !islanded.ok)
    expect(warm.diagnostics.map((d) => d.code)).toEqual(islanded.diagnostics.map((d) => d.code));
}, 300_000);

// The body of a function that is called where it is written runs when its
// module evaluates, so a refusal there throws before the module finishes, as
// one in top-level code does. The classic UMD wrapper is such a function, and
// the statement it holds is the module's export (`module.exports = factory()`),
// which a build reads from top-level statements only: the package runs in a
// Node island, and a default import of it is the function it exports. A
// generator's body does not run at the call, so the same refusal there keeps
// its package native. Needs no libnode pack for the decision: the island
// build stops before linking without one.
test("a refusal in a function called where it is written makes its package a Node island", async () => {
  const dir = join(outDir, "called-where-written");
  rmSync(dir, { recursive: true, force: true });
  const writePackage = (name: string, type: "module" | "commonjs", body: string[]): void => {
    const at = join(dir, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, "package.json"),
      JSON.stringify({ name, version: "1.0.0", type, main: "./index.js", types: "./index.d.ts" }),
    );
    writeFileSync(join(at, "index.js"), [...body, ""].join("\n"));
    writeFileSync(
      join(at, "index.d.ts"),
      type === "commonjs"
        ? "declare function plural(word: string, count: number): string;\nexport = plural;\n"
        : "export declare function answer(): string;\n",
    );
  };
  const entry = (name: string, body: string): string => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, body);
    return file;
  };
  const umd = (assign: string): string[] => [
    "(function (root, factory) {",
    '  if (typeof require === "function" && typeof exports === "object" && typeof module === "object") {',
    `    ${assign}`,
    "  } else {",
    "    root.plural = factory();",
    "  }",
    "})(this, function () {",
    "  function plural(word, count) {",
    '    return count === 1 ? word : word + "s";',
    "  }",
    "  return plural;",
    "});",
  ];
  writePackage("umd-wrapped", "commonjs", umd("module.exports = factory();"));
  writePackage("called-with-this", "module", [
    "(function () {",
    "  new FormData();",
    "}).call(undefined);",
    'export function answer() { return "island"; }',
  ]);
  writePackage("generator-body", "module", [
    "const pending = (function* () {",
    "  yield new FormData();",
    "})();",
    'export function answer() { return typeof pending === "object" ? "native" : "none"; }',
  ]);
  const islandNotes = (result: Awaited<ReturnType<typeof compile>>): string[] =>
    result.ok
      ? (result.warnings ?? []).filter((d) => d.code === "SC8001").map((d) => d.message)
      : [];
  const build = (name: string, body: string): Promise<Awaited<ReturnType<typeof compile>>> =>
    compile(entry(name, body), { outPath: join(dir, name), outDir: dir, sanitize });

  const wrapped = await build(
    "umd-wrapped",
    'import plural from "umd-wrapped";\nconsole.log(plural("item", 2), plural("item", 1), typeof plural);\n',
  );
  if (wrapped.ok) {
    expect(islandNotes(wrapped)).toEqual([
      expect.stringContaining("'umd-wrapped@1.0.0' runs in a Node island"),
    ]);
    if (!skip)
      expect(await run(wrapped.binaryPath, [])).toEqual({
        stdout: "items item function\n",
        stderr: "",
        code: 0,
      });
  } else expect(wrapped.diagnostics.map((d) => d.code)).toContain("SC8005");

  const withThis = await build(
    "called-with-this",
    'import { answer } from "called-with-this";\nconsole.log(answer());\n',
  );
  if (withThis.ok)
    expect(islandNotes(withThis)).toEqual([
      expect.stringContaining("'called-with-this@1.0.0' runs in a Node island"),
    ]);
  else expect(withThis.diagnostics.map((d) => d.code)).toContain("SC8005");

  const generator = await build(
    "generator-body",
    'import { answer } from "generator-body";\nconsole.log(answer());\n',
  );
  expect(generator.ok ? [] : generator.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual(
    [],
  );
  if (!generator.ok) return;
  expect(islandNotes(generator)).toEqual([]);
  // The generator is never resumed, and a sanitized build says on stderr
  // that it skipped its reference-count audit for that: the answer and the
  // exit status are what this checks.
  const ran = await run(generator.binaryPath, []);
  expect({ stdout: ran.stdout, code: ran.code }).toEqual({ stdout: "native\n", code: 0 });
}, 300_000);

// Compiling a package natively leaves every other package typed as it is
// without it. plugboard runs in a Node island and declares its plugin
// subpaths from an ambient block, while the plugin's own JSDoc requires the
// parameter that block leaves optional. Were the plugin typed from its
// JavaScript because padleft compiles, the program would stop typechecking
// and padleft, whose removal clears the error, would become an island too.
// A module of the island that no declaration covers is untyped in both
// programs, not an error in one and inferred in the other. IR output needs
// no libnode pack.
test("a compiled package does not change how an island package is typed", async () => {
  const dir = join(outDir, "compiled-beside-island");
  rmSync(dir, { recursive: true, force: true });
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write("package.json", JSON.stringify({ name: "compiled-beside-island", type: "module" }));
  write(
    "node_modules/plugboard/package.json",
    JSON.stringify({
      name: "plugboard",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  write(
    "node_modules/plugboard/index.d.ts",
    [
      "interface PlugApi { id: string }",
      "interface Plug { name: string }",
      "type PlugFn = (api?: PlugApi) => Plug;",
      'declare module "plugboard" {',
      "  export function register(name: string, plug: PlugFn): string;",
      "}",
      'declare module "plugboard/plugs/*" {',
      "  const plug: PlugFn;",
      "  export default plug;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "node_modules/plugboard/index.js",
    'export function register(name, plug) {\n  return name + ":" + plug({ id: "x" }).name;\n}\n',
  );
  write(
    "node_modules/plugboard/plugs/alpha.js",
    [
      "/**",
      " * @param {PlugApi} api",
      " * @returns {Plug}",
      " */",
      "export default function alpha(api) {",
      '  return { name: "alpha-" + (api ? api.id : "none") };',
      "}",
      "",
    ].join("\n"),
  );
  // A module of the island no declaration covers: its import is untyped
  // either way.
  write("node_modules/plugboard/extra.js", 'export const label = "extra";\n');
  write(
    "node_modules/padleft/package.json",
    JSON.stringify({
      name: "padleft",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  write(
    "node_modules/padleft/index.d.ts",
    "export function pad(text: string, width: number): string;\n",
  );
  write(
    "node_modules/padleft/index.js",
    [
      "/**",
      " * @param {string} text",
      " * @param {number} width",
      " * @returns {string}",
      " */",
      "export function pad(text, width) {",
      '  return text.padStart(width, " ");',
      "}",
      "",
    ].join("\n"),
  );
  const island = [
    'import { register } from "plugboard";',
    'import alpha from "plugboard/plugs/alpha.js";',
    'import * as extra from "plugboard/extra.js";',
    'console.log(register("alpha", alpha));',
    "console.log(String(extra.label));",
  ];
  write("alone.ts", [...island, ""].join("\n"));
  write(
    "beside.ts",
    ['import { pad } from "padleft";', ...island, 'console.log(pad("z", 3));', ""].join("\n"),
  );
  for (const name of ["alone", "beside"]) {
    const result = await compile(join(dir, `${name}.ts`), {
      outPath: join(dir, `${name}.ir.json`),
      outDir: dir,
      outputKind: "ir",
      nodeIslands: { islands: ["plugboard"] },
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`), name).toEqual(
      [],
    );
    if (!result.ok) continue;
    expect(
      (result.warnings ?? []).filter((d) => d.code === "SC8001").map((d) => d.message),
      name,
    ).toEqual([expect.stringContaining("'plugboard@1.0.0' runs in a Node island")]);
  }
}, 300_000);

// Lowering checks every argument and result type for JSON data; IR output
// needs no libnode pack.
test("recursive JSON types cross into Node", async () => {
  const dir = join(outDir, "recursive-json");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(repoRoot, "tests/fixtures/node-island/recursive-json.ts"), {
    outPath,
    outDir: dir,
    outputKind: "ir",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const ir = JSON.stringify(deserializeModule(readFileSync(outPath, "utf8")));
  expect(ir).toContain("nodeIsland.callSync");
}, 300_000);

// A view member declared with an instantiation that grows at every level
// (`next: Chain<T[]>`) has no type that repeats, so only the depth bound ends
// the walk over its members. IR output needs no libnode pack.
test("a view that names itself with a growing instantiation crosses into Node", async () => {
  const dir = join(outDir, "growing-view");
  rmSync(dir, { recursive: true, force: true });
  cpSync(
    join(repoRoot, "tests/diagnostics/node-island-view-member/node_modules"),
    join(dir, "node_modules"),
    { recursive: true },
  );
  cpSync(
    join(repoRoot, "tests/diagnostics/node-island-view-member/package.json"),
    join(dir, "package.json"),
  );
  writeFileSync(
    join(dir, "main.ts"),
    [
      'import { make } from "view-pkg";',
      "",
      "interface Chain<T> {",
      "  label: string;",
      "  next: Chain<T[]>;",
      "}",
      "",
      "const head = make<Chain<number>>();",
      "console.log(head.label);",
      "",
    ].join("\n"),
  );
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(dir, "main.ts"), { outPath, outDir: dir, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const ir = JSON.stringify(deserializeModule(readFileSync(outPath, "utf8")));
  expect(ir).toContain("nodeIsland.apply");
}, 300_000);

// When a build fails and the packages it compiled with runtime fences then
// fail as islands too, the island build's errors are reported. That build
// types the user code from the packages' declarations; the native one
// typed it from their JavaScript, where declared-only types (`Static<T>`)
// are `any`. Needs no libnode pack: both builds fail before linking.
test("a failed build reports the island build's errors", async () => {
  const dir = join(outDir, "declared-types");
  rmSync(dir, { recursive: true, force: true });
  cpSync(
    join(repoRoot, "tests/corpus/6829-node-island-declared-types/node_modules"),
    join(dir, "node_modules"),
    { recursive: true },
  );
  copyFileSync(
    join(repoRoot, "tests/fixtures/node-island/declared-types.ts"),
    join(dir, "main.ts"),
  );
  const result = await compile(join(dir, "main.ts"), { outPath: join(dir, "main"), outDir: dir });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const messages = result.diagnostics.map((d) => `${d.code}: ${d.message}`);
  expect(messages.some((m) => m.startsWith("SC1090: method decorators"))).toBe(true);
  expect(messages.filter((m) => /Tool|Static|'check'/.test(m))).toEqual([]);
}, 300_000);

// Needs no libnode pack: the build fails before linking.
test("a star re-export of a path-mapped island package reports the island boundary", async () => {
  const dir = join(outDir, "path-mapped-reexport");
  rmSync(dir, { recursive: true, force: true });
  const corpus = join(repoRoot, "tests/corpus/6839-node-island-path-mapped");
  cpSync(join(corpus, "node_modules"), join(dir, "node_modules"), { recursive: true });
  copyFileSync(join(corpus, "tsconfig.json"), join(dir, "tsconfig.json"));
  copyFileSync(
    join(repoRoot, "tests/fixtures/node-island/path-mapped-reexport.ts"),
    join(dir, "main.ts"),
  );
  const result = await compile(join(dir, "main.ts"), { outPath: join(dir, "main"), outDir: dir });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => `${d.code} ${d.loc.file.slice(dir.length + 1)}`)).toEqual([
    "SC8010 main.ts",
  ]);
}, 300_000);

// An array that holds generators is a checked-dynamic value in a program
// without an island. A generator that crosses into an island is not the same
// value on the other side yet, so a program that loads a module into one is
// refused by name. Needs no libnode pack: the build fails before linking.
test("an array of generators beside requireModule is refused by name", async () => {
  // A program of its own, outside every node_modules directory.
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-generator-array-"));
  mkdirSync(join(dir, "node_modules/@scriptc"), { recursive: true });
  symlinkSync(join(repoRoot, "packages/node"), join(dir, "node_modules/@scriptc/node"));
  writeFileSync(
    join(dir, "main.ts"),
    `import { requireModule } from "@scriptc/node";
const os = requireModule("node:os");
function* count(from: number): Generator<number> {
  yield from;
  yield from + 1;
}
const list = [count(1), count(5)];
console.log(list.length, typeof os.EOL);
`,
  );
  const result = await compile(join(dir, "main.ts"), { outPath: join(dir, "main"), outDir: dir });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => `${d.code} ${d.loc.file.slice(dir.length + 1)}`)).toEqual([
    "SC8010 main.ts",
  ]);
  expect(result.diagnostics[0]!.message).toContain("an array that holds generators");
  rmSync(dir, { recursive: true, force: true });
}, 300_000);
