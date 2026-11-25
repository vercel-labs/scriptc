/* The island load plan (compiler node-islands/load-plan.ts, runtime
 * scr_node_island_hooks.cjs): the build computes what Node's resolver
 * answers for the shipped module tree, and the island answers from it.
 * What the corpus cannot see is asserted here: that the plan ships, that
 * the island answers from it, and that a program prints the same with the
 * plan off and with every answer checked against Node's
 * (SCRIPTC_NODE_ISLANDS_PLAN=off|verify). The programs are the corpus's
 * `node-island-plan` ones. Needs a libnode pack in SCRIPTC_LIBNODE
 * (libnode.ts). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-load-plan");
const skip = libnodePack() === null;

const programs = readdirSync(corpus)
  .filter((name) => name.includes("-node-island-plan-"))
  .sort();

/** Builds a corpus program with the plan trace on; answers the binary and
 * the build's plan lines. */
async function build(
  name: string,
  flags: string[] = [],
): Promise<{ binary: string; trace: string[] }> {
  const dir = join(outDir, name + flags.join(""));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "plan",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
  };
  const { stderr } = await execFileAsync(
    process.execPath,
    [cli, "build", join(corpus, name, "main.ts"), "-o", binary, ...flags],
    { env, encoding: "utf8" },
  );
  return { binary, trace: stderr.split("\n").filter((l) => l.startsWith("[node-islands] plan")) };
}

interface Run {
  stdout: string;
  code: number;
  /** The island's plan lines (SCRIPTC_NODE_ISLANDS_TRACE=plan), with the
   * tree's place on the machine cut off. */
  plan: string[];
}

async function run(binary: string, extra: Record<string, string> = {}): Promise<Run> {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: join(outDir, "cache"),
    SCRIPTC_NODE_ISLANDS_TRACE: "plan",
    // Whatever the lane sets, each run here says what it wants.
    SCRIPTC_NODE_ISLANDS_PLAN: "",
    ...extra,
  };
  const done = await execFileAsync(binary, [], { env, encoding: "utf8" }).then(
    (ok) => ({ ...ok, code: 0 }),
    (error: { stdout: string; stderr: string; code: number }) => error,
  );
  return {
    stdout: done.stdout,
    code: done.code,
    plan: done.stderr
      .split("\n")
      .filter((l) => l.startsWith("[node-islands] plan "))
      .map((l) =>
        l
          .slice("[node-islands] plan ".length)
          .replace(/(?:file:\/\/)?\/\S*\/(node_modules\/)/g, "$1"),
      ),
  };
}

describe.skipIf(skip)("the island load plan", () => {
  test("the build plans every package and says what it leaves to Node", async () => {
    const { trace } = await build("8939-node-island-plan-paths");
    const line = (pkg: string): string => trace.find((l) => l.includes(`plan ${pkg}:`)) ?? "";
    expect(line("node_modules/pathesm")).toMatch(/2 files, 1 relative requests answered$/);
    // helper.js calls require.resolve: its request is Node's.
    expect(line("node_modules/pathcjs")).toMatch(
      /3 files, 2 relative requests answered; left to Node: 1 the module uses require other than by calling it$/,
    );
    expect(trace.at(-1)).toMatch(/plan: \d+ bytes at \.scriptc\/load-plan/);
  }, 300_000);

  test("the island answers relative requests and entry loads from the plan", async () => {
    const { binary } = await build("8955-node-island-plan-interop");
    const traced = await run(binary);
    expect(traced.code).toBe(0);
    const from = (file: string): string[] =>
      traced.plan
        .filter((l) => l.startsWith("resolve ") && l.endsWith(` from node_modules/mixpkg/${file}`))
        .map((l) => l.split(" ")[1]!);
    // The program's own load names the entry by its path.
    expect(traced.plan.some((l) => /^resolve \S*mixpkg\/index\.js from the program$/.test(l))).toBe(
      true,
    );
    // CommonJS imported from ES code and a JSON import with its attribute
    // are Node's to resolve.
    expect(from("index.js")).toEqual([]);
    expect(from("loader.cjs")).toEqual([
      "./probe/both",
      "./probe/both/",
      "./probe/dir",
      "./probe/data",
      "./probe",
      "./probe/",
      "./probe/module.mjs",
      "./probe/dir/../both.js",
      "./data",
    ]);
    const off = await run(binary, { SCRIPTC_NODE_ISLANDS_PLAN: "off" });
    expect(off.plan).toEqual([]);
    expect(off.stdout).toBe(traced.stdout);
  }, 300_000);

  test("an ES module the plan resolved is read by the island", async () => {
    const { binary } = await build("8910-node-island-plan-live-bindings");
    const traced = await run(binary);
    const loaded = traced.plan
      .filter((l) => l.startsWith("load "))
      .map((l) => l.slice(l.lastIndexOf("/") + 1))
      .sort();
    expect(loaded).toEqual(["label.js", "ops.js", "state.js"]);
  }, 300_000);

  test("a patched loader takes its requests back", async () => {
    const { binary } = await build("8942-node-island-plan-patched-loader");
    const traced = await run(binary);
    const answered = traced.plan
      .filter((l) => l.startsWith("resolve ./"))
      .map((l) => l.split(" ")[1]!);
    // ./second and what it requires resolve while fs.realpathSync is the
    // package's wrapper, ./pick after the extension table changed.
    expect(answered).toEqual(["./first", "./third"]);
    expect(traced.stdout).toBe("first second third second.js,second-part.js pick.json\n");
  }, 300_000);

  test("the tree beside the executable holds the plan", async () => {
    const { binary } = await build("8930-node-island-plan-lazy-require", ["--libnode=beside"]);
    expect(existsSync(`${binary}.libnode/modules/.scriptc/load-plan`)).toBe(true);
    const traced = await run(binary);
    expect(traced.code).toBe(0);
    expect(
      traced.plan.filter((l) => l.startsWith("resolve ./")).map((l) => l.split(" ")[1]),
    ).toEqual(["./light", "./heavy", "./optional", "./heavy.js"]);
  }, 300_000);

  test("a tree that lost a module or the plan still runs the program", async () => {
    const { binary } = await build("8910-node-island-plan-live-bindings");
    const cache = join(outDir, "thinned-cache");
    rmSync(cache, { recursive: true, force: true });
    const env = { XDG_CACHE_HOME: cache };
    const whole = await run(binary, env);
    expect(whole.code).toBe(0);
    const trees = join(cache, "scriptc", "node-islands");
    // The module tree is named by its digest; Node's compile cache for it
    // is beside it (`<digest>.compile-cache`).
    const installed = readdirSync(trees)
      .filter((name) => /^[0-9a-f]{64}$/.test(name))
      .map((name) => join(trees, name));
    expect(installed.length).toBe(1);
    // A module the plan names and the island reads itself: the plan does
    // not look at the disk, so the read is what fails, on the file's path.
    rmSync(join(installed[0]!, "node_modules/livepkg/ops.js"));
    const thinned = await run(binary, env);
    expect(thinned.stdout).toBe(whole.stdout);
    expect(thinned.code).toBe(0);
    for (const tree of installed) rmSync(join(tree, ".scriptc/load-plan"), { force: true });
    const unplanned = await run(binary, env);
    expect(unplanned.stdout).toBe(whole.stdout);
    expect(unplanned.code).toBe(0);
  }, 300_000);

  test.for(programs)(
    "%s prints the same with the plan off and with every answer checked",
    async (name) => {
      const { binary } = await build(name);
      const planned = await run(binary);
      const off = await run(binary, { SCRIPTC_NODE_ISLANDS_PLAN: "off" });
      const verified = await run(binary, { SCRIPTC_NODE_ISLANDS_PLAN: "verify" });
      expect(planned.plan.length).toBeGreaterThan(0);
      expect(off.plan).toEqual([]);
      expect(off.stdout).toBe(planned.stdout);
      expect(off.code).toBe(planned.code);
      expect(verified.stdout).toBe(planned.stdout);
      expect(verified.code).toBe(planned.code);
    },
    300_000,
  );
});
