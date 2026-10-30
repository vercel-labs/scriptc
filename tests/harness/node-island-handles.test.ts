/* Island object handles (scope-B NI-4) where a differential corpus program
 * cannot show it: handles to Node objects the program dropped are released,
 * so the import table does not grow with the work a program does (acyclic
 * garbage; node-island-gc.test.ts covers cycles across both heaps). The
 * corpus (6812-6815) pins handle semantics against Node. An island package
 * ships with the program, so the executable runs without the tree it was
 * built from. Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-handles");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

describe.skipIf(skip)("Node island handles", () => {
  test("handles the program dropped are released", async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island/handles-leak.mjs"), {
      outPath: join(outDir, "handles-leak"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "handles" };
    const counts: number[] = [];
    for (const n of ["2000", "20000"]) {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [n], {
        env,
        encoding: "utf8",
      });
      expect(stdout).toMatch(/^sum \d+ 499500 object -1\n$/);
      const live = /\[node-islands\] live handles (\d+)/.exec(stderr);
      expect(live).not.toBeNull();
      counts.push(Number(live![1]));
    }
    // The module and the kept object (with util.inspect, at most a few
    // more), independent of the number of iterations.
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBeLessThan(8);
  }, 300_000);

  async function runFixture(name: string, entry: string): Promise<string> {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island", entry), {
      outPath: join(dir, name),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
    return (await execFileAsync(result.binaryPath, [], { env, encoding: "utf8" })).stdout;
  }

  test("island member calls and assignments evaluate in JavaScript's order", async () => {
    expect(await runFixture("order", "order/main.ts")).toBe(
      "original\nreceiver,key,value,receiver,value 1 1\n",
    );
  }, 300_000);

  test("requireModule() loads Node's built-in modules", async () => {
    expect(await runFixture("builtins", "builtins.ts")).toBe("a/b string\n");
  }, 300_000);

  /** Runs a binary that refuses at run time: its stderr. */
  async function refusal(binary: string): Promise<string> {
    const run = await execFileAsync(binary, [], { encoding: "utf8" }).catch(
      (e: { stderr?: string }) => e,
    );
    return String((run as { stderr?: string }).stderr ?? "");
  }

  test("a package marked native never runs in a Node island", async () => {
    // esmbridge's native build has deferred refusals (its CommonJS exports
    // object read as a value, an Object.keys form), so by default it runs in
    // a Node island; marked native, it compiles natively and refuses at run
    // time.
    const dir = join(outDir, "native-policy");
    mkdirSync(dir, { recursive: true });
    const entry = join(repoRoot, "tests/fixtures/npm/cases/cjs-esm-named/main.ts");
    const islanded = await compile(entry, { outPath: join(dir, "main"), outDir: dir, sanitize });
    // The SC8001 notes that name esmbridge.
    const islandNotes = (r: typeof islanded): string[] =>
      r.ok
        ? (r.warnings ?? [])
            .filter((d) => d.code === "SC8001" && d.message.includes("'esmbridge@"))
            .map((d) => d.message)
        : [];
    expect(islanded.ok).toBe(true);
    expect(islandNotes(islanded)).toHaveLength(1);
    const marked = await compile(entry, {
      outPath: join(dir, "marked"),
      outDir: dir,
      sanitize,
      nodeIslands: { native: ["esmbridge"] },
    });
    expect(marked.ok).toBe(true);
    expect(islandNotes(marked)).toEqual([]);
    if (marked.ok)
      expect(await refusal(marked.binaryPath)).toMatch(/\[SC\d{4} at [^\]]*\/esmbridge\//);
  }, 300_000);

  /** The SC8001 notes of a build that name `pkg`. */
  async function islandNotesOf(entry: string, name: string, pkg: string): Promise<string[]> {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(repoRoot, entry), {
      outPath: join(dir, name),
      outDir: dir,
      sanitize,
    });
    expect(result.ok, name).toBe(true);
    if (!result.ok) return [];
    return (result.warnings ?? [])
      .filter((d) => d.code === "SC8001" && d.message.includes(`'${pkg}@`))
      .map((d) => d.message);
  }

  test("a package whose fences may never run stays native", async () => {
    // jose's run-time fences are inside function bodies, on paths a program
    // may never call: only fences that surely fire make a Node island.
    expect(
      await islandNotesOf("tests/corpus/6331-jose-root-entry/main.ts", "jose-native", "jose"),
    ).toEqual([]);
  }, 300_000);

  test("a fence in module code makes a Node island, with the ES modules importing it", async () => {
    // cjszoo's module code sets its exports object's prototype (R2.2), so
    // its fence fires when it loads; esmbridge's ES module imports names
    // from it, which only Node's CommonJS facade gives as Node does.
    const entry = "tests/fixtures/npm/cases/cjs-esm-named/main.ts";
    const zoo = await islandNotesOf(entry, "fence-sure", "cjszoo");
    expect(zoo).toHaveLength(1);
    expect(zoo[0]).toContain("R2.2");
    const bridge = await islandNotesOf(entry, "fence-sure", "esmbridge");
    expect(bridge).toEqual([
      "package 'esmbridge@1.0.0' runs in a Node island: packaging: an ES module of the package imports the CommonJS island package 'cjszoo'",
    ]);
  }, 300_000);

  test("without islands, a package's deferred refusals refuse at run time", async () => {
    // With --node-islands=off, packages whose native builds have deferred
    // refusals compile natively and report them when they run: orderkit's
    // createRequire call with a computed specifier (SC2020), and the first
    // one cjs-esm-named reaches in its packages (esmbridge, cjszoo).
    const cases = [
      ["order-off", "tests/fixtures/node-island/order/main.ts", /\[SC2020 at [^\]]*\/orderkit\//],
      [
        "esm-named-off",
        "tests/fixtures/npm/cases/cjs-esm-named/main.ts",
        /\[SC\d{4} at [^\]]*\/node_modules\/(?:esmbridge|cjszoo)\//,
      ],
    ] as const;
    for (const [name, entry, code] of cases) {
      const dir = join(outDir, name);
      mkdirSync(dir, { recursive: true });
      const result = await compile(join(repoRoot, entry), {
        outPath: join(dir, name),
        outDir: dir,
        sanitize,
        nodeIslands: { mode: "off" },
      });
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      expect((result.warnings ?? []).map((d) => d.code)).not.toContain("SC8001");
      expect(await refusal(result.binaryPath), name).toMatch(code);
    }
  }, 300_000);

  test("an island array that contradicts its declaration throws at the crossing", async () => {
    // The crossing copies the island's array element-wise, and the checked
    // conversion throws on an element of the wrong type: `lie()` declares
    // string[] and hands back numbers, so no number reaches a native
    // string[]. (A corpus program cannot pin this: Node prints the numbers.)
    const root = join(outDir, "declared-arrays-lie");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6897-node-island-declared-arrays"), root, {
      recursive: true,
    });
    copyFileSync(
      join(repoRoot, "tests/fixtures/node-island/declared-arrays-lie.ts"),
      join(root, "main.ts"),
    );
    const result = await compile(join(root, "main.ts"), {
      outPath: join(root, "main"),
      outDir: root,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(await refusal(result.binaryPath)).toContain(
      "TypeError: expected string at $[0], got number",
    );
  }, 300_000);

  test("an island record that contradicts its declaration throws at the crossing", async () => {
    // A record the island hands back crosses as a deep checked copy:
    // `unsafe<T>` declares the caller's own record type and hands back a
    // JSON object whose `fg` is a number, so the copy's conversion throws
    // before a number reaches a native string field.
    const root = join(outDir, "unsafe-record-lie");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6899-node-island-unsafe-record"), root, {
      recursive: true,
    });
    copyFileSync(
      join(repoRoot, "tests/fixtures/node-island/unsafe-record-lie.ts"),
      join(root, "main.ts"),
    );
    const result = await compile(join(root, "main.ts"), {
      outPath: join(root, "main"),
      outDir: root,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(await refusal(result.binaryPath)).toContain(
      "TypeError: expected string at $.fg, got number",
    );
  }, 300_000);

  test("an island package ships with the program", async () => {
    const root = join(outDir, "ships");
    const src = join(root, "src");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6816-node-island-objects"), src, { recursive: true });
    const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache") };
    const built: Record<string, string> = {};
    for (const libnode of ["inside", "beside"]) {
      const dir = join(root, libnode);
      mkdirSync(dir, { recursive: true });
      const result = await compile(join(src, "main.ts"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        ...(libnode === "beside" ? { libnode } : {}),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      built[libnode] = result.binaryPath;
    }
    const before = await execFileAsync(built["inside"]!, [], { env, encoding: "utf8" });
    expect(before.stdout).toMatch(/^islandkit \d/);
    // The executable names its island package by its path in the shipped
    // tree, never by the directory it was built from.
    expect(readFileSync(built["inside"]!).toString("latin1").includes(src)).toBe(false);
    // Beside the executable, the tree holds the package's files.
    const index = readFileSync(join(src, "node_modules/islandkit/index.js"), "utf8");
    const modules = join(root, "beside/main.libnode/modules");
    const files = readdirSync(modules, { recursive: true, encoding: "utf8" });
    expect(
      files.some((f) => f.endsWith("index.js") && readFileSync(join(modules, f), "utf8") === index),
    ).toBe(true);
    renameSync(src, join(root, "moved"));
    for (const binary of Object.values(built)) {
      const after = await execFileAsync(binary, [], { env, encoding: "utf8" });
      expect(after.stdout).toBe(before.stdout);
    }
  }, 300_000);
});
