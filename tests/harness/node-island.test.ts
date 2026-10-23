/* Node islands loaded in-process (scope-B milestone NI-1), where it cannot
 * be a differential corpus program: a run that never calls into Node never
 * maps libnode, the beside packaging carries its own pack, a missing or
 * mismatched pack fails the first call with a message, and the executable
 * links no Node and exports nothing libnode could bind to. The corpus
 * (6800-6803) pins the call semantics against Node. Needs a libnode pack
 * in SCRIPTC_LIBNODE; required in the Linux x64 CI lanes (libnode.ts). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

async function run(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
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

async function build(name: string, libnode?: string): Promise<string> {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const result = await compile(fixture, {
    outPath: join(dir, "lifecycle"),
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

  test("beside packaging carries its own pack", async () => {
    const beside = await build("beside", "beside");
    expect(existsSync(join(outDir, "beside/lifecycle.libnode/manifest.json"))).toBe(true);
    const env = { ...process.env };
    delete env["SCRIPTC_LIBNODE"];
    const result = await run(beside, [], env);
    expect(result.stdout).toBe(`${before}\n42\n${after}\ndone\n`);
    expect(result.code).toBe(0);
  }, 300_000);

  test("a missing pack fails the first call", async () => {
    const result = await run(binary, [], { ...process.env, SCRIPTC_LIBNODE: "/nonexistent/pack" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${before}\n`);
    expect(result.stderr).toMatch(
      /^scriptc: cannot load Node\.js for this program's Node islands: .*\/nonexistent\/pack\/libscr_node_bridge\.(so|dylib).*\n$/,
    );
  });

  test("a pack of another Node version fails the first call", async () => {
    const dir = await fakePack("old-node", "SCR_NODE_BRIDGE_ABI", "22.11.0");
    const result = await run(binary, [], { ...process.env, SCRIPTC_LIBNODE: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      new RegExp(
        `^scriptc: this program's Node islands need libnode \\d+\\.\\d+\\.\\d+; found 22\\.11\\.0 \\(NODE_MODULE_VERSION 127\\) at ${dir}\\n$`,
      ),
    );
  });

  test("a bridge of another ABI fails the first call", async () => {
    const dir = await fakePack("other-abi", "999u", "24.22.0");
    const result = await run(binary, [], { ...process.env, SCRIPTC_LIBNODE: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `scriptc: the libnode pack at ${dir} has an incompatible bridge (ABI 999; this program needs 9)\n`,
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
