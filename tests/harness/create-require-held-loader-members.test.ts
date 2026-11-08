/* A member of a createRequire loader read through a value that holds the
 * loader, in TypeScript. The held loader is a function over the runtime
 * resolver and carries none of the properties Node's require does, so the
 * read has no answer. The refusal is the statement's: the program builds,
 * the build names each such statement (warning SC6015), and the statement
 * throws the refusal by name when it runs. A program that never reaches the
 * read runs as it does under Node. The programs name the loader's type by
 * what createRequire returns, so they read the same with the bundled
 * declarations (this test) and with @types/node, which also declares
 * `extensions`.
 *
 * These cannot be corpus programs: under Node the read answers. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(import.meta.dirname, "../../node_modules/.cache/scriptc-tests/held-loader");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Built {
  binary: string;
  /** The SC6015 warnings of the build: line and message of each. */
  deferred: { line: number; message: string }[];
}

async function build(name: string, source: string): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-held-loader-${name}-`));
  try {
    mkdirSync(outDir, { recursive: true });
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const outPath = join(outDir, name);
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    return {
      binary: outPath,
      deferred: warnings
        .filter((w) => w.code === "SC6015")
        .map((w) => ({
          line: source.slice(0, w.loc.start).split("\n").length,
          message: w.message,
        }))
        .sort((a, b) => a.line - b.line),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(binary: string, args: string[] = []): Promise<Run> {
  try {
    const pending = execFileAsync(binary, args, { encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

const REFUSAL = (member: string): string =>
  `createRequire loader member '${member}' read through a value that holds the loader`;

// A shelf holds the loader; the reads sit behind a command-line switch, so
// one binary shows the path that never reaches them and each path that does.
const SHELF = `import { createRequire } from "node:module";
const open = createRequire(import.meta.url);
type Loader = ReturnType<typeof createRequire>;
interface Shelf {
  open: Loader;
}
function note(text: string): string {
  console.log(text);
  return text;
}
function locate(held: Loader, title: string): string {
  return held.resolve(note(title));
}
function catalogue(shelf: Shelf): boolean {
  return shelf.open.cache !== undefined;
}
function first(shelf: Shelf): boolean {
  return shelf.open.main === undefined;
}
const shelf: Shelf = { open };
const mode = process.argv[2] ?? "none";
console.log("start " + mode);
if (mode === "resolve") console.log(locate((note("holder"), open), "node:fs"));
if (mode === "cache") console.log(catalogue(shelf));
if (mode === "main") console.log(first(shelf));
if (mode === "guarded") {
  try {
    console.log(locate(open, "node:fs"));
  } catch (e) {
    console.log("caught " + (e instanceof Error) + " " + (e as Error).message);
  }
}
console.log("end " + mode);
`;

test("the build names each read of a held loader's member, once", async () => {
  const built = await build("shelf-warnings", SHELF);
  expect(built.deferred.map((w) => w.line)).toEqual([12, 15, 18]);
  for (const [at, member] of ["resolve", "cache", "main"].entries()) {
    expect(built.deferred[at]!.message).toContain(
      `this statement throws when it runs (SC2020: '${REFUSAL(member)}'`,
    );
  }
}, 240_000);

test("a program that never reaches the read runs to its end", async () => {
  const built = await build("shelf-unreached", SHELF);
  expect(await run(built.binary)).toEqual({
    stdout: "start none\nend none\n",
    stderr: "",
    exitCode: 0,
  });
}, 240_000);

test("a reached read throws the refusal by name, after the holder and the arguments ran", async () => {
  const built = await build("shelf-reached", SHELF);
  const resolved = await run(built.binary, ["resolve"]);
  expect(resolved.stdout).toBe("start resolve\nholder\nnode:fs\n");
  expect(resolved.exitCode).not.toBe(0);
  expect(resolved.stderr).toContain(REFUSAL("resolve"));
  expect(resolved.stderr).toMatch(/\[SC2020 at [^\]]*main\.ts:12\]/);
  for (const [member, line] of [
    ["cache", 15],
    ["main", 18],
  ] as const) {
    const r = await run(built.binary, [member]);
    expect(r.stdout, member).toBe(`start ${member}\n`);
    expect(r.exitCode, member).not.toBe(0);
    expect(r.stderr, member).toContain(REFUSAL(member));
    expect(r.stderr, member).toMatch(new RegExp(`\\[SC2020 at [^\\]]*main\\.ts:${line}\\]`));
  }
}, 240_000);

test("the thrown refusal is an Error the program's own handler receives", async () => {
  const built = await build("shelf-guarded", SHELF);
  const r = await run(built.binary, ["guarded"]);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe("");
  const lines = r.stdout.split("\n");
  expect(lines[0]).toBe("start guarded");
  expect(lines[1]).toBe("node:fs");
  expect(lines[2]).toContain("caught true ");
  expect(lines[2]).toContain(REFUSAL("resolve"));
  expect(lines[3]).toBe("end guarded");
}, 240_000);
