/* Executable runtime reachability. The source-runtime recipe intentionally
 * still includes the complete historical base for direct compileC callers;
 * executable section GC is what makes its unused functions/data disappear.
 * These fixtures therefore pin both halves of that contract: hello has no
 * reachable members from the formerly-unavoidable families, while every
 * feature fixture retains an anchor and behaves exactly like Node. */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/runtime-tree-shaking");
const portableTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;

interface Fixture {
  name: string;
  source: string;
  anchor: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "child",
    source: `import { spawnSync } from "node:child_process";
const r = spawnSync("/bin/echo", ["child"], { encoding: "utf8" });
console.log(r.stdout.trim(), r.status);
`,
    anchor: "scr_spawn_sync",
  },
  {
    name: "path-posix",
    source: `import { join } from "node:path/posix";
console.log(join("a", "..", "b"));
`,
    anchor: "scr_path_join",
  },
  {
    name: "path-win32",
    source: `import { join } from "node:path/win32";
console.log(join("C:\\\\a", "..", "b"));
`,
    anchor: "scr_path_win32_join",
  },
  {
    name: "url",
    source: `import { fileURLToPath, pathToFileURL } from "node:url";
console.log(fileURLToPath(pathToFileURL("/tmp/a b")));
`,
    // This composition is optimized through the URL bridge, so its direct
    // anchors are the file-path conversion helpers rather than URL parsing.
    anchor: "scr_url_from_path",
  },
  {
    name: "json-parse",
    source: `console.log(JSON.parse('{"ok":true}').ok);
`,
    anchor: "scr_json_parse",
  },
  {
    name: "date",
    source: `console.log(new Date(0).toISOString());
`,
    anchor: "scr_date_to_iso",
  },
  {
    name: "stream-consumers-json",
    source: `import { Readable } from "node:stream";
import { json } from "node:stream/consumers";
const stream = new Readable({ read() {} });
stream.push('{"value":7}');
stream.push(null);
console.log((await json(stream)).value);
`,
    anchor: "scr_json_parse",
  },
];

async function build(name: string, source: string) {
  const outDir = join(cacheDir, name);
  const sourcePath = join(outDir, "main.mjs");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(sourcePath, source);
  const result = await compile(sourcePath, {
    outPath: join(outDir, "program"),
    outDir,
    // The C lane proves source-toolchain linking. macOS additionally runs
    // the default lane below, which selects the helper/runtime-pack path.
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  return { sourcePath, binaryPath: result.binaryPath };
}

async function output(command: string, args: string[]): Promise<string> {
  return (await execFileAsync(command, args, { encoding: "utf8" })).stdout;
}

async function symbols(binaryPath: string): Promise<string> {
  // `nm` is supplied by Xcode/binutils on the supported native lanes. Global
  // executable symbols are the meaningful ABI/reachability contract: local
  // compiler bookkeeping may legitimately retain a similarly named datum.
  return output("nm", ["-g", binaryPath]);
}

async function expectNodeParity(sourcePath: string, binaryPath: string, args: string[] = []): Promise<void> {
  const [node, native] = await Promise.all([
    output(process.execPath, [sourcePath, ...args]),
    output(binaryPath, args),
  ]);
  expect(native).toBe(node);
}

portableTest("static hello strips unreachable runtime families while feature programs retain them", async () => {
  const helloSource = `console.log("hello", "world");\n`;
  const hello = await build("hello", helloSource);
  await expectNodeParity(hello.sourcePath, hello.binaryPath);
  const helloSymbols = await symbols(hello.binaryPath);
  for (const family of [
    "scr_path_win32_",
    "scr_exec_",
    "scr_url_",
    "scr_json_parse",
    "scr_date_",
  ]) {
    expect(helloSymbols, `hello retains ${family}`).not.toContain(family);
  }

  const built = [] as { fixture: Fixture; binaryPath: string }[];
  for (const fixture of FIXTURES) {
    // /bin/echo is the portable POSIX child fixture. The Windows child
    // surface remains covered by its cross-target corpus contracts.
    if (fixture.name === "child" && process.platform === "win32") continue;
    const result = await build(fixture.name, fixture.source);
    await expectNodeParity(result.sourcePath, result.binaryPath);
    const nativeSymbols = await symbols(result.binaryPath);
    expect(nativeSymbols, `${fixture.name} lost ${fixture.anchor}`).toContain(fixture.anchor);
    built.push({ fixture, binaryPath: result.binaryPath });
  }

  // Page-sized slack makes this a directional regression check rather than a
  // linker-version byte-count pin. Child is a representative formerly-base
  // payload and must remain materially larger than a no-feature executable.
  const child = built.find(({ fixture }) => fixture.name === "child");
  if (child !== undefined) {
    expect(statSync(hello.binaryPath).size + 16 * 1024).toBeLessThan(statSync(child.binaryPath).size);
  }
});

portableTest("fetch response JSON retains the URL and parser runtime", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    const fixture: Fixture = {
      name: "fetch-response-json",
      source: `const response = await fetch(process.argv[2]);
console.log((await response.json()).ok);
`,
      anchor: "scr_json_parse",
    };
    const result = await build(fixture.name, fixture.source);
    await expectNodeParity(result.sourcePath, result.binaryPath, [`http://127.0.0.1:${address.port}`]);
    const nativeSymbols = await symbols(result.binaryPath);
    expect(nativeSymbols).toContain("scr_json_parse");
    expect(nativeSymbols).toContain("scr_url_release");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// The helper emits a native program object only on supported macOS arm64.
// Its normal backend path links the precompiled runtime pack; run the same
// reachability assertion there so the source-only C lane cannot regress it.
test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "macOS helper/runtime-pack links dead-strip static hello too",
  async () => {
    const outDir = join(cacheDir, "hello-runtime-pack");
    const sourcePath = join(outDir, "main.mjs");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(sourcePath, `console.log("hello", "world");\n`);
    const result = await compile(sourcePath, { outPath: join(outDir, "program"), outDir });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    await expectNodeParity(sourcePath, result.binaryPath);
    const nativeSymbols = await symbols(result.binaryPath);
    for (const family of ["scr_path_win32_", "scr_exec_", "scr_url_", "scr_json_parse", "scr_date_"]) {
      expect(nativeSymbols, `runtime pack retained ${family}`).not.toContain(family);
    }
  },
);
