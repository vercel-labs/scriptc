/* Package shims (packages/compiler/src/frontend/package-shims.ts) beyond the
 * npm differential cases that run them against Node:
 *
 * - a package the project marks unloaded stays unloaded when it IS
 *   installed: the native program prints what Node prints without the
 *   package, and the package's code never runs;
 * - the same behind import(): an unloaded workspace package, and a module
 *   only import() loads that imports an unloaded package, reject with
 *   Node's ERR_MODULE_NOT_FOUND;
 * - a polyfill package with a builtin alias that the project marks unloaded
 *   stays unloaded: its require throws MODULE_NOT_FOUND;
 * - a shimmed package that is not installed, or whose major version has no
 *   shim, resolves exactly as before (here: refused like any missing or
 *   uncompiled package), `--npm-static` does not compile a version the
 *   registry entry does not list in `sourceVersions`, and a listed version
 *   compiles the package's own source rather than a shim;
 * - the undici shims keep memory bounded against a peer that sends endless
 *   chunk-size lines and large or compressed bodies, and the 5.x profile
 *   rejects a Host value with CR or LF as undici 5.29 does (the vendored
 *   5.12 writes it into the request);
 * - fetch aborts a redirect it follows or rejects, so a redirect body that
 *   never ends does not keep its connection busy (undici 7 leaves that
 *   connection open with its body paused).
 * - a CommonJS package's require() of a shimmed package (fs-extra, required
 *   by an installed package's JavaScript) compiles the shim, and matches
 *   Node running the real package;
 * - the undici 5.x shim's ProxyAgent sends what undici 5.29 sends through a
 *   proxy in the test process (the CONNECT request, credentials, a refused
 *   tunnel), and its fetch takes the global RequestInit;
 * - the undici shim compiles under a project tsconfig with
 *   strictPropertyInitialization off;
 * - the undici shim compiles in a project whose own @types/node declares no
 *   DOMException global (20.11 and earlier): the declaration joins the
 *   program beside the project's types, and an aborted fetch rejects with
 *   the DOMException undici rejects with.
 */
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const casesRoot = join(repoRoot, "tests/fixtures/npm/cases");
const shimFixtures = join(repoRoot, "tests/fixtures/package-shims");
const fsExtraModules = join(repoRoot, "tests/corpus/fs-extra-package/node_modules");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch = mkdtempSync(join(tmpdir(), "scriptc-package-shims-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: "utf8" });
  return stdout;
}

/** A copy of an npm fixture case in the scratch directory. */
function copyCase(name: string, as: string): string {
  const dir = join(scratch, as);
  cpSync(join(casesRoot, name), dir, { recursive: true });
  return dir;
}

function installEncoding(dir: string): void {
  const pkg = join(dir, "node_modules/encoding");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    '{ "name": "encoding", "version": "0.1.13", "main": "index.js" }\n',
  );
  writeFileSync(
    join(pkg, "index.js"),
    "'use strict';\nconsole.log('encoding loaded');\nexports.convert = (text) => Buffer.from(String(text));\n",
  );
}

/** Compiles `entry` (a file in tests/fixtures/package-shims) as main.ts of
 * a copy of the npm case `name`, which carries the package. */
async function buildInCase(name: string, entry: string): Promise<{ dir: string; binary: string }> {
  const dir = copyCase(name, `${name}-${entry.replace(/\..*$/, "")}`);
  copyFileSync(join(shimFixtures, entry), join(dir, "main.ts"));
  const out = join(dir, ".scriptc");
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(out, "program"),
    outDir: out,
    sanitize,
  });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return { dir, binary: result.binaryPath };
}

/** The cells of an options table (`label: outcome` lines): how many are
 * the same under the real undici and the built-in one, how many the
 * built-in refuses by name, and the labels of any other difference. */
function cellsAgainst(
  undici: string,
  builtIn: string,
): { same: number; refused: number; different: string[] } {
  const cells = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of text.split("\n")) {
      const at = line.indexOf(": ");
      if (at !== -1) out.set(line.slice(0, at), line.slice(at + 2));
    }
    return out;
  };
  const theirs = cells(undici);
  const ours = cells(builtIn);
  let same = 0;
  let refused = 0;
  const different: string[] = [];
  for (const [label, outcome] of theirs) {
    const here = ours.get(label);
    if (here === outcome) same++;
    else if (
      here !== undefined &&
      here.includes("NotSupportedError") &&
      here.includes("scriptc's undici")
    )
      refused++;
    else different.push(label);
  }
  for (const label of ours.keys()) if (!theirs.has(label)) different.push(label);
  return { same, refused, different };
}

/** Runs `binary <port>` against undici-hostile-peer.mjs. */
async function runAgainstPeer(binary: string, cwd: string): Promise<string> {
  const peer = spawn(process.execPath, [join(shimFixtures, "undici-hostile-peer.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      peer.stdout.once("data", (d: Buffer) => resolve(d.toString().trim()));
      peer.once("exit", (code) => reject(new Error(`peer exited with ${code}`)));
    });
    return await run(binary, [port], cwd);
  } finally {
    peer.stdin.end();
  }
}

describe("package shims", () => {
  test("an unloaded package is never loaded, even when installed", async () => {
    const original = join(casesRoot, "unloaded-optional-dependency");
    const expected = await run(process.execPath, [join(original, "main.ts")], original);
    expect(expected).toContain("MODULE_NOT_FOUND: Cannot find module 'encoding'");

    const dir = copyCase("unloaded-optional-dependency", "unloaded-installed");
    installEncoding(dir);
    // Control: Node loads the installed package.
    expect(await run(process.execPath, [join(dir, "main.ts")], dir)).toContain("encoding loaded");

    const out = join(dir, ".scriptc");
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe(expected);
  }, 180_000);

  test("unloaded packages behind import() stay unloaded, even when installed", async () => {
    const original = join(casesRoot, "unloaded-dynamic-import");
    const expected = await run(process.execPath, [join(original, "main.ts")], original);
    expect(expected).toContain("parser: ERR_MODULE_NOT_FOUND");
    expect(expected).toContain("lazy: ERR_MODULE_NOT_FOUND");
    expect(expected).toContain("dep: ERR_MODULE_NOT_FOUND");

    const dir = copyCase("unloaded-dynamic-import", "unloaded-dynamic-installed");
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    // A workspace package (linked into node_modules from outside it) and an
    // installed ES module package.
    write(
      "workspace/parser/package.json",
      '{ "name": "wsunloadedparser", "version": "1.0.0", "type": "module", "main": "./index.ts" }\n',
    );
    write(
      "workspace/parser/index.ts",
      'console.log("parser loaded");\nexport function parse(text: string): string {\n  return `parsed:${text}`;\n}\n',
    );
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync("../workspace/parser", join(dir, "node_modules/wsunloadedparser"));
    write(
      "node_modules/gtunloadedheavy/package.json",
      '{ "name": "gtunloadedheavy", "version": "1.0.0", "type": "module", "main": "index.js", "types": "index.d.ts" }\n',
    );
    write(
      "node_modules/gtunloadedheavy/index.js",
      'console.log("heavy loaded");\nexport function heavy(text) {\n  return `heavy:${text}`;\n}\n',
    );
    write(
      "node_modules/gtunloadedheavy/index.d.ts",
      "export declare function heavy(text: string): string;\n",
    );
    // Control: Node loads both.
    const loaded = await run(process.execPath, [join(dir, "main.ts")], dir);
    expect(loaded).toContain("parsed parsed:a");
    expect(loaded).toContain("heavy:b");

    const out = join(dir, ".scriptc");
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe(expected);
  }, 180_000);

  test("a CommonJS package requiring fs-extra compiles the shim", async () => {
    const dir = join(scratch, "fs-extra-require");
    cpSync(fsExtraModules, join(dir, "node_modules"), { recursive: true });
    const pkg = join(dir, "node_modules/fxuser");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "fxuser", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    writeFileSync(
      join(pkg, "index.js"),
      [
        "'use strict';",
        "const fs = require('fs-extra');",
        "exports.exists = function (p) { return fs.pathExistsSync(p); };",
        "exports.read = function (p) { return fs.readFile(p, 'utf8'); };",
        "exports.write = async function (p, obj) { await fs.outputJson(p, obj); return fs.readJsonSync(p); };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pkg, "index.d.ts"),
      [
        "export declare function exists(p: string): boolean;",
        "export declare function read(p: string): Promise<string>;",
        "export declare function write(p: string, obj: unknown): Promise<unknown>;",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "data.txt"), "data\n");
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import { exists, read, write } from "fxuser";',
        "async function main(): Promise<void> {",
        '  console.log(exists("data.txt"), exists("missing.txt"));',
        '  console.log(JSON.stringify(await read("data.txt")));',
        '  console.log(JSON.stringify(await write("out/nested/a.json", { a: [1] })));',
        "}",
        "main();",
        "",
      ].join("\n"),
    );
    const expected = await run(process.execPath, [join(dir, "main.ts")], dir);
    rmSync(join(dir, "out"), { recursive: true, force: true });
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe(expected);
  }, 180_000);

  test("an unloaded polyfill package is not compiled as its builtin", async () => {
    const dir = join(scratch, "unloaded-alias");
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write("package.json", '{ "private": true, "type": "module" }\n');
    write(
      "node_modules/uses-isarray/package.json",
      '{ "name": "uses-isarray", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    write(
      "node_modules/uses-isarray/index.js",
      "'use strict';\nexports.outcome = function () {\n  try {\n    return typeof require('isarray');\n  } catch (e) {\n    return e.code;\n  }\n};\n",
    );
    write("node_modules/uses-isarray/index.d.ts", "export declare function outcome(): string;\n");
    write("main.ts", 'import { outcome } from "uses-isarray";\nconsole.log(outcome());\n');
    // Node without the package.
    expect(await run(process.execPath, [join(dir, "main.ts")], dir)).toBe("MODULE_NOT_FOUND\n");

    write(
      "package.json",
      '{ "private": true, "type": "module", "scriptc": { "packages": { "isarray": "unloaded" } } }\n',
    );
    write(
      "node_modules/isarray/package.json",
      '{ "name": "isarray", "version": "1.0.0", "main": "index.js" }\n',
    );
    write(
      "node_modules/isarray/index.js",
      "var toString = {}.toString;\nmodule.exports = Array.isArray || function (arr) {\n  return toString.call(arr) == '[object Array]';\n};\n",
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe("MODULE_NOT_FOUND\n");
  }, 180_000);

  test("a shimmed package that is not installed is not shimmed", async () => {
    const dir = join(scratch, "undici-missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.ts"),
      'import { request } from "undici";\nconsole.log(typeof request);\n',
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    expect(result.ok).toBe(false);
  }, 180_000);

  test("an unsupported major version is not shimmed", async () => {
    const dir = join(scratch, "undici-v6");
    const pkg = join(dir, "node_modules/undici");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "undici", "version": "6.21.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    writeFileSync(join(pkg, "index.js"), "exports.version = 6;\n");
    writeFileSync(join(pkg, "index.d.ts"), "export declare const version: number;\n");
    writeFileSync(
      join(dir, "main.ts"),
      'import { version } from "undici";\nconsole.log(version);\n',
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      sanitize,
    });
    // The package's own declarations type the import (no shim exports
    // `version`); whatever the npm compile then decides, it is not the shim.
    if (result.ok) {
      expect(await run(result.binaryPath, [], dir)).toBe("6\n");
    } else {
      expect(result.diagnostics.map((d) => d.message).join("\n")).not.toContain("shims/undici");
    }
  }, 180_000);

  test("--npm-static leaves out an implemented package at a version it does not list", async () => {
    const dir = join(scratch, "undici-v6-npm-static");
    const pkg = join(dir, "node_modules/undici");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "undici", "version": "6.21.0", "main": "index.js" }\n',
    );
    writeFileSync(join(pkg, "index.js"), "exports.version = 6;\n");
    writeFileSync(
      join(dir, "main.mts"),
      'import { version } from "undici";\nconsole.log(version);\n',
    );
    const result = await compile(join(dir, "main.mts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      npmStatic: ["undici"],
      sanitize,
    });
    // The package's JavaScript is not part of the program, so the import
    // has no declarations. A TypeScript entry requires them; a JavaScript
    // entry would load the package in a Node island.
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(
      "Could not find a declaration file for module 'undici'",
    );
  }, 180_000);

  test("--npm-static compiles the source of a listed version of an implemented package", async () => {
    const dir = join(scratch, "chalk-v4-npm-static");
    const pkg = join(dir, "node_modules/chalk");
    mkdirSync(join(pkg, "source"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{ "name": "chalk", "version": "4.1.2", "main": "source/index.js", "types": "source/index.d.ts" }\n',
    );
    writeFileSync(
      join(pkg, "source/index.js"),
      "'use strict';\nexports.paint = (text) => '<' + text + '>';\n",
    );
    writeFileSync(
      join(pkg, "source/index.d.ts"),
      "export declare function paint(text: string): string;\n",
    );
    writeFileSync(
      join(dir, "main.ts"),
      'import { paint } from "chalk";\nconsole.log(paint("x"));\n',
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, ".scriptc/program"),
      outDir: join(dir, ".scriptc"),
      npmStatic: ["chalk"],
      sanitize,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    expect(await run(result.binaryPath, [], dir)).toBe("<x>\n");
  }, 180_000);

  for (const name of ["undici7", "undici5"]) {
    test(`${name}: endless chunk-size lines and large bodies stay in bounded memory`, async () => {
      const { dir, binary } = await buildInCase(name, "undici-bounded.ts");
      const out = await runAgainstPeer(binary, dir);
      expect(out.split("\n").slice(0, 4)).toEqual([
        "/extension 200 hello",
        "/zeros 200 hello",
        "/big 200 64 MiB",
        "/bomb 200 64 MiB",
      ]);
      // ASan's shadow memory and quarantine keep freed buffers mapped.
      if (!sanitize) expect(out.split("\n")[4]).toBe("rss under 48 MiB");
    }, 300_000);
  }

  test("undici7: fetch closes the connection of a redirect it follows or rejects", async () => {
    const { dir, binary } = await buildInCase("undici7", "undici-redirect.ts");
    expect(await runAgainstPeer(binary, dir)).toBe(
      [
        "follow 200 closed",
        "error mode TypeError fetch failed",
        "after error mode closed",
        "",
      ].join("\n"),
    );
  }, 180_000);

  test("undici5: a Host value with CR or LF throws before the request is written", async () => {
    const { dir, binary } = await buildInCase("undici5", "undici5-host.ts");
    // undici 5.29.0's output.
    expect(await run(binary, [], dir)).toBe(
      [
        '"ok.test" 204',
        '"a\\r\\nX-Injected: 1" InvalidArgumentError UND_ERR_INVALID_ARG invalid host header',
        '"a\\nb" InvalidArgumentError UND_ERR_INVALID_ARG invalid host header',
        "",
      ].join("\n"),
    );
  }, 180_000);

  test("undici5: fetch compiles in a project whose @types/node declares no DOMException global", async () => {
    const dir = copyCase("undici5", "undici5-old-node-types");
    // The vendored @types/node without its DOMException global, which is
    // what the shim sees of @types/node 20.11 and earlier: the project's own
    // code cannot name the class, the shim's fetch does.
    const vendored = join(repoRoot, "tests/fixtures/node-types/node_modules");
    const types = join(dir, "node_modules/@types/node");
    cpSync(join(vendored, "@types/node"), types, { recursive: true });
    cpSync(join(vendored, "undici-types"), join(dir, "node_modules/undici-types"), {
      recursive: true,
    });
    const reference = '/// <reference path="web-globals/domexception.d.ts" />\n';
    const index = readFileSync(join(types, "index.d.ts"), "utf8");
    expect(index).toContain(reference);
    writeFileSync(join(types, "index.d.ts"), index.replace(reference, ""));
    rmSync(join(types, "web-globals/domexception.d.ts"));
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(
      join(dir, "main.ts"),
      [
        'import { createServer } from "node:http";',
        'import { fetch } from "undici";',
        "const server = createServer((req, res) => {",
        '  if (req.url === "/slow") return;',
        "  res.end(`${req.method} ${req.url}`);",
        "});",
        'server.listen(0, "127.0.0.1", async () => {',
        "  const address = server.address();",
        '  const port = typeof address === "object" && address ? address.port : 0;',
        "  const ok = await fetch(`http://127.0.0.1:${port}/ok`);",
        "  console.log(ok.status, await ok.text());",
        "  const controller = new AbortController();",
        "  const pending = fetch(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });",
        "  controller.abort();",
        "  try {",
        "    await pending;",
        '    console.log("not aborted");',
        "  } catch (error) {",
        "    const failure = error as Error;",
        "    console.log(failure.name, failure.message, failure instanceof Error);",
        "  }",
        "  server.closeAllConnections();",
        "  server.close();",
        "});",
        "",
      ].join("\n"),
    );
    const out = join(dir, ".scriptc");
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
    // undici 5.29.0's output under Node.
    expect(await run(result.binaryPath, [], dir)).toBe(
      "200 GET /ok\nAbortError This operation was aborted true\n",
    );
  }, 300_000);

  test("undici5: ProxyAgent tunnels every request through HTTP CONNECT", async () => {
    const { dir, binary } = await buildInCase("undici5", "undici5-proxy-agent.ts");
    // undici 5.29.0's output under Node 24 (the vendored fixture is 5.12).
    expect(await run(binary, [], dir)).toBe(
      [
        "true false false",
        "200 GET /one host=127.0.0.1:<target> x=a",
        "200 GET /two host=127.0.0.1:<target> x=a",
        "2 CONNECT 127.0.0.1:<target> HTTP/1.1 | host: 127.0.0.1:<proxy> | connection: close || CONNECT 127.0.0.1:<target> HTTP/1.1 | host: 127.0.0.1:<proxy> | connection: close",
        "200 POST /post host=127.0.0.1:<target> x=-",
        "200 GET /fetched host=127.0.0.1:<target> x=f 0",
        "true true",
        "200 GET /token host=127.0.0.1:<target> x=-",
        "200 GET /user host=127.0.0.1:<target> x=-",
        "200 GET /auth host=127.0.0.1:<target> x=-",
        "CONNECT 127.0.0.1:<target> HTTP/1.1 | host: 127.0.0.1:<proxy> | connection: close | x-via: fixture | proxy-authorization: Bearer secret || CONNECT 127.0.0.1:<target> HTTP/1.1 | host: 127.0.0.1:<proxy> | connection: close | proxy-authorization: Basic dXNlcjpwYSBzcw== || CONNECT 127.0.0.1:<target> HTTP/1.1 | host: 127.0.0.1:<proxy> | connection: close | proxy-authorization: Basic dXNlcjpwYXNz",
        "200 GET /global host=127.0.0.1:<target> x=- true 1",
        "AbortError UND_ERR_ABORTED Proxy response (407) !== 200 when HTTP Tunneling",
        "TypeError fetch failed cause: Error Request was cancelled.",
        "true 2",
        "InvalidArgumentError UND_ERR_INVALID_ARG Proxy opts.uri is mandatory",
        "InvalidArgumentError UND_ERR_INVALID_ARG opts.auth cannot be used in combination with opts.token",
        "TypeError Invalid URL",
        "InvalidArgumentError UND_ERR_INVALID_ARG Proxy-Authorization should be sent in ProxyAgent constructor",
        "",
      ].join("\n"),
    );
  }, 180_000);

  test("undici5: fetch takes the global RequestInit and sends byte bodies", async () => {
    const { dir, binary } = await buildInCase("undici5", "undici5-fetch-init.ts");
    // undici 5.29.0's output under Node 24.
    expect(await run(binary, [], dir)).toBe(
      [
        'variable: 200 POST station=north tide=high type=text/plain;charset=UTF-8 bytes=9 "0612 4.2m"',
        'pairs: 200 PUT station=north tide=low type=text/plain;charset=UTF-8 bytes=9 "1240 0.9m"',
        'headers object: 200 POST station=south tide=slack type=text/plain;charset=UTF-8 bytes=1 "-"',
        'nothing: 200 GET station=south tide=- type=- bytes=0 ""',
        'signal and redirect: 200 GET station=east tide=- type=- bytes=0 ""',
        'typed array: 200 POST station=west tide=- type=- bytes=5 "hi!\\n\u00ff"',
        'array buffer: 200 POST station=- tide=- type=- bytes=3 "hi!"',
        'data view: 200 POST station=- tide=- type=- bytes=2 "\\n\u00ff"',
        'dispatcher: 200 POST station=pier tide=ebb type=text/plain;charset=UTF-8 bytes=9 "1903 1.4m"',
        'dispatcher bytes: 200 POST station=pier tide=- type=- bytes=5 "hi!\\n\u00ff"',
        'other method: 200 PROPFIND station=pier tide=- type=- bytes=0 ""',
        'request: 200 REPORT station=pier tide=- type=- bytes=0 ""',
        "aborted: AbortError",
        "",
      ].join("\n"),
    );
  }, 180_000);

  test("undici5: the global fetch sends a request through a dispatcher of the package", async () => {
    const { dir, binary } = await buildInCase("undici5", "undici5-global-fetch-relay.ts");
    // Node 24 with undici 5.29.0 installed: its global fetch dispatches
    // through the package's objects.
    expect(await run(binary, [], dir)).toBe(
      [
        'straight | 200 GET /parcels/1 bay=A parcel="" | tunnels 0',
        'in the init | 200 GET /parcels/2 bay=B parcel="" | tunnels 1',
        'in the init, with a body | 200 POST /parcels bay=none parcel="crate of pears" | tunnels 2',
        'assigned | 200 PUT /parcels/3 bay=none parcel="two crates" | tunnels 2',
        'assigned again | 200 GET /parcels/4 bay=C parcel="" | tunnels 2',
        'own class | 200 GET /parcels/5 bay=none parcel="" | tunnels 2',
        "handed on 1",
        'agent | 200 GET /parcels/6 bay=D parcel="" | tunnels 2',
        "agent used the relay: false",
        'never set | 200 DELETE /parcels/7 bay=none parcel="" | tunnels 2',
        'undefined | 200 GET /parcels/8 bay=none parcel="" | tunnels 2',
        "",
      ].join("\n"),
    );
  }, 180_000);

  test("undici5: the global fetch refuses, by name, an object that is no dispatcher of the package", async () => {
    // Written in the init, the object is refused when the program is built.
    await expect(
      buildInCase("undici5", "undici5-global-fetch-literal-dispatch.ts"),
    ).rejects.toThrow(
      /RequestInit option 'dispatcher' holding an object that is no dispatcher of the undici package/,
    );
    // Reached through a record, it is refused where the call runs.
    const { dir, binary } = await buildInCase("undici5", "undici5-global-fetch-own-dispatch.ts");
    expect(await run(binary, [], dir)).toBe(
      "NotSupportedError | scriptc's undici fetch takes a dispatcher made by this undici (Agent, Pool, Client, ProxyAgent or a subclass of Dispatcher)\n",
    );
  }, 180_000);

  // Every RequestInit member, one value per cell, without a dispatcher and
  // through an Agent. `expected` is the built-in undici's output; `undici`
  // is the real package's under Node 24 (5.29.0 for the 5.x entry, 7.30.0
  // for the 7.x one). A cell is the same in both, or the built-in refuses
  // it naming the member: nothing is taken and then not acted on.
  test.each([
    ["undici5", "5.29.0", 132, 64],
    ["undici7", "7.30.0", 131, 65],
  ])(
    "%s: every RequestInit member is acted on as undici %s does, or refused by name",
    async (name, release, same, refused) => {
      const { dir, binary } = await buildInCase(name, "undici-fetch-members.ts");
      const expected = readFileSync(join(shimFixtures, `undici-fetch-members.${name}.txt`), "utf8");
      const undici = readFileSync(
        join(shimFixtures, `undici-fetch-members.undici-${release}.txt`),
        "utf8",
      );
      expect(await run(binary, [], dir)).toBe(expected);
      expect(cellsAgainst(undici, expected)).toEqual({ same, refused, different: [] });
    },
    180_000,
  );

  test("undici5: every ProxyAgent option is applied as undici 5.29.0 applies it, or refused by name", async () => {
    const { dir, binary } = await buildInCase("undici5", "undici5-proxy-agent-options.ts");
    cpSync(join(shimFixtures, "tls"), join(dir, "tls"), { recursive: true });
    const expected = readFileSync(
      join(shimFixtures, "undici5-proxy-agent-options.undici5.txt"),
      "utf8",
    );
    const undici = readFileSync(
      join(shimFixtures, "undici5-proxy-agent-options.undici-5.29.0.txt"),
      "utf8",
    );
    expect(await run(binary, [], dir)).toBe(expected);
    // Among the cells that are the same: a proxy URL that is an IPv6 literal
    // reaches the proxy, a line break in a token or a header fails the
    // request before the proxy is dialed, and an https origin's certificate
    // is checked against the origin's name.
    expect(cellsAgainst(undici, expected)).toEqual({ same: 43, refused: 13, different: [] });
    expect(expected).toContain(
      "uri with an IPv6 literal: 200 origin GET /p | proxy saw CONNECT 127.0.0.1:PORT HTTP/1.1 / host: [::1]:PORT / connection: close",
    );
    expect(expected).toContain(
      "token with a line break: threw InvalidArgumentError UND_ERR_INVALID_ARG: invalid proxy-authorization header | proxy saw nothing",
    );
    expect(expected).toContain(
      "tls, certificate of the proxy's address: threw Error ERR_TLS_CERT_ALTNAME_INVALID",
    );
  }, 180_000);

  // The global RequestInit a program holds, spread whole into the package's
  // fetch and into a wrapper's init that names the package's dispatch(),
  // under the declarations the compiler bundles (these cases have no
  // @types/node); undici-shim-types.test.ts has the same under the Node
  // types of the 20 line.
  test.each(["undici5", "undici7"])(
    "%s: the bundled RequestInit spread whole fits the package's fetch and dispatch()",
    async (name) => {
      const dir = copyCase(name, `${name}-whole-init`);
      copyFileSync(join(shimFixtures, "undici-whole-init.ts"), join(dir, "main.ts"));
      const out = join(dir, ".scriptc");
      const result = await compile(join(dir, "main.ts"), {
        outPath: join(out, "program"),
        outDir: out,
        outputKind: "ir",
      });
      expect(
        result.ok,
        !result.ok ? result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n") : "",
      ).toBe(true);
    },
    120_000,
  );

  test("undici7: the shim compiles under a project with strictPropertyInitialization off", async () => {
    const dir = copyCase("undici7", "undici7-loose");
    // tsc accepts the shim's Request#body here because it is assigned in the
    // constructor; the lowering only sees top-level assignments, so the
    // field carries an initializer and the class lowers.
    writeFileSync(
      join(dir, "tsconfig.json"),
      '{ "compilerOptions": { "strict": false, "strictNullChecks": true } }\n',
    );
    // Frontend only: the refusal was a lowering diagnostic, and stopping
    // before codegen keeps this to the module graph's frontend cost.
    const out = join(dir, ".scriptc");
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      outputKind: "ir",
    });
    expect(
      result.ok,
      !result.ok ? result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n") : "",
    ).toBe(true);
  }, 120_000);
});
