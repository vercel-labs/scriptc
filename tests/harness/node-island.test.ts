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
      `scriptc: the libnode pack at ${dir} has an incompatible bridge (ABI 999; this program needs 10)\n`,
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
    async function buildDir(dir: string, name: string) {
      return withFreshBuildCache(() =>
        compile(join(dir, "main.ts"), {
          outPath: join(dir, name),
          outDir: dir,
          sanitize,
          libnode: pack!,
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

    test("replacing process.stdout.write beside an island is an SC8006 error", async () => {
      // The planner refuses the combination (the island's process.stdout is
      // its own object), so it is an error. It used to be SC8020, which the
      // renderer prints as a warning and the planner still failed the build
      // on: a diagnostic is a warning or an error, never both.
      const dir = copyCorpus(
        "stdio-patch",
        `import { installPatch } from "./patch.ts";
installPatch();
process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
console.log("ok");
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
      const refusal = messages(result).find(
        (m) => m.startsWith("SC8006:") && m.includes("process.stdout.write"),
      );
      expect(refusal).toBeDefined();
      expect(messages(result).filter((m) => m.startsWith("SC8020:"))).toEqual([]);
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

  // The build-time probe evaluates modules to decide their deferral. A
  // program module that runs in an island loads eagerly, so the build never
  // evaluates the program's own source; the executable evaluates it when
  // the entry requires it.
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
});

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

// A program module that runs in an island never reaches the deferral
// decision, whose probe evaluates the modules it decides: lowering loads it
// eagerly. SCRIPTC_NODE_ISLANDS_TRACE=defer prints every decision; IR
// output needs no libnode pack.
test("a program module that runs in an island is never a deferral candidate", async () => {
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
    expect(written.filter((line) => line.includes("sloppy.js"))).toEqual([]);
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
