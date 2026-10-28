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
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
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
    const helper = join(outDir, "beside/lifecycle.libnode/modules/helper.cjs");
    expect(readFileSync(helper, "utf8")).toBe(
      readFileSync(join(repoRoot, "tests/fixtures/node-island/helper.cjs"), "utf8"),
    );
    const env = { ...process.env, XDG_CACHE_HOME: cacheHome };
    delete env["SCRIPTC_LIBNODE"];
    const result = await run(beside, [], env);
    expect(result.stdout).toBe(`${before}\n42\n${after}\ndone\n`);
    expect(result.code).toBe(0);
    // Modules that no longer match the executable are refused.
    writeFileSync(helper, `${readFileSync(helper, "utf8")}\n// edited\n`);
    const edited = await run(beside, [], env);
    expect(edited.code).toBe(1);
    expect(edited.stderr).toBe(
      `scriptc: the Node island modules at ${join(outDir, "beside/lifecycle.libnode/modules")} do not match this program\n`,
    );
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
    const [digest] = readdirSync(islands);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(islands).mode & 0o777).toBe(0o700);
    expect(statSync(join(islands, digest!)).mode & 0o777).toBe(0o700);
    // An entry that no longer matches is not used: the run extracts the
    // modules into a directory of its own instead.
    writeFileSync(join(islands, digest!, "helper.cjs"), "exports.answer = () => 0;\n");
    expect((await run(join(moved, "app"), [], env)).stdout).toBe(`${before}\n42\n${after}\ndone\n`);
  });

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

  test("a call from a worker thread throws", async () => {
    const worker = await build(
      "worker",
      undefined,
      join(repoRoot, "tests/fixtures/node-island/worker.ts"),
    );
    expect(await run(worker, [])).toEqual({
      stdout:
        "main 42\nworker Node islands run on the main thread only; this call came from a worker thread\nexit 0\n",
      stderr: "",
      code: 0,
    });
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
      `scriptc: the libnode pack at ${dir} has an incompatible bridge (ABI 999; this program needs 3)\n`,
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
});

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
