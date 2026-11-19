/* A program that builds with a deferred site must say so at build time.
 *
 * A JavaScript statement that does not compile is deferred to run time: the
 * program builds, and the statement throws its refusal only if it runs. Until
 * this warning existed the build said nothing about such a site, so a build
 * log could look clean while the program's stderr carried the only record of
 * it (and a bare fence — a function value whose body did not compile, such as
 * the object literal closure in the Tabs primitive — was not even listed as
 * deferred by `scriptc coverage`). The build now names every deferred site
 * with warning SC6015 at its file:line, whether or not the fence carries the
 * diagnostic's tag.
 *
 * These cannot be corpus programs: the deferred statement completes under
 * Node, so running it natively would differ from the oracle. The program here
 * never reaches the site, which is exactly the case the warning serves. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(
  import.meta.dirname,
  "../../node_modules/.cache/scriptc-tests/deferred-warning",
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("the build names each deferred site at its file and line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deferred-warning-"));
  try {
    mkdirSync(outDir, { recursive: true });
    const part = join(dir, "part.js");
    writeFileSync(
      part,
      "export function keep(found, el, channel, name) {\n" +
        "  return void found.get(el)?.[channel]?.delete(name)\n" +
        "}\n",
    );
    const entry = join(dir, "main.mjs");
    writeFileSync(entry, 'import { keep } from "./part.js"\nconsole.log(typeof keep)\n');
    const outPath = join(outDir, "deferred-warning");
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const text = readFileSync(part, "utf8");
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    const deferred = warnings.filter((w) => w.code === "SC6015");
    expect(
      deferred.map((w) => ({
        file: w.loc.file,
        line: text.slice(0, w.loc.start).split("\n").length,
      })),
    ).toEqual([{ file: part, line: 2 }]);
    expect(deferred[0]!.message).toContain("SC1090");
    const run = await execFileAsync(outPath, [], { encoding: "utf8" });
    expect(run.stdout).toBe("function\n");
    expect(run.stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a guarded site does not hide the same refusal elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deferred-guarded-"));
  try {
    mkdirSync(outDir, { recursive: true });
    const part = join(dir, "part.js");
    writeFileSync(
      part,
      "export function guarded(found, el, channel, name) {\n" +
        "  try {\n" +
        "    return void found.get(el)?.[channel]?.delete(name)\n" +
        "  } catch {\n" +
        "    return undefined\n" +
        "  }\n" +
        "}\n" +
        "export function unguarded(found, el, channel, name) {\n" +
        "  return void found.get(el)?.[channel]?.delete(name)\n" +
        "}\n",
    );
    const entry = join(dir, "main.mjs");
    writeFileSync(
      entry,
      'import { guarded, unguarded } from "./part.js"\nconsole.log(typeof guarded, typeof unguarded)\n',
    );
    const outPath = join(outDir, "deferred-guarded");
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const text = readFileSync(part, "utf8");
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    const lines = (code: string): number[] =>
      warnings
        .filter((w) => w.code === code)
        .map((w) => text.slice(0, w.loc.start).split("\n").length);
    expect(lines("SC6015")).toEqual([9]);
    expect(lines("SC6012")).toEqual([3]);
    const run = await execFileAsync(outPath, [], { encoding: "utf8" });
    expect(run.stdout).toBe("function function\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deferred refusal that is a library call's validation ladder is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deferred-ladder-"));
  try {
    mkdirSync(outDir, { recursive: true });
    const part = join(dir, "part.js");
    writeFileSync(
      part,
      "export function segments() {\n" +
        '  return new Intl.Segmenter("en", { granularity: "sentence" }).segment("hi")\n' +
        "}\n",
    );
    const entry = join(dir, "main.mjs");
    writeFileSync(entry, 'import { segments } from "./part.js"\nconsole.log(typeof segments)\n');
    const outPath = join(outDir, "deferred-ladder");
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const text = readFileSync(part, "utf8");
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    const deferred = warnings.filter((w) => w.code === "SC6015");
    expect(deferred.map((w) => text.slice(0, w.loc.start).split("\n").length)).toEqual([2]);
    expect(deferred[0]!.message).toContain("Intl.Segmenter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
