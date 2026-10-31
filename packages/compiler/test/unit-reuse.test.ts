import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const VARIABLES = [
  "SCRIPTC_CACHE_DIR",
  "SCRIPTC_INCR_LOWERING",
  "SCRIPTC_INCR_VERIFY",
  "SCRIPTC_LOWER_JOURNAL_DUMP",
];

afterEach(() => {
  for (const name of VARIABLES) delete process.env[name];
});

/** A program in a scratch directory, built with unit reuse into its own
 * cache and without it. */
class Workspace {
  private builds = 0;
  constructor(readonly dir: string) {}

  static async create(files: Record<string, string>): Promise<Workspace> {
    const workspace = new Workspace(await mkdtemp(join(tmpdir(), "scriptc-unit-reuse-")));
    for (const [name, text] of Object.entries(files)) await workspace.write(name, text);
    return workspace;
  }

  write(name: string, text: string): Promise<void> {
    return writeFile(join(this.dir, name), text);
  }

  async edit(name: string, from: string, to: string): Promise<void> {
    const text = await readFile(join(this.dir, name), "utf8");
    expect(text, `${name} spells ${from}`).toContain(from);
    await this.write(name, text.replace(from, to));
  }

  private async lower(label: string, reuse: boolean, verify = false): Promise<string> {
    for (const name of VARIABLES) delete process.env[name];
    if (reuse) {
      process.env["SCRIPTC_CACHE_DIR"] = join(this.dir, "cache");
      process.env["SCRIPTC_INCR_LOWERING"] = "1";
      process.env["SCRIPTC_LOWER_JOURNAL_DUMP"] = join(this.dir, label);
      if (verify) process.env["SCRIPTC_INCR_VERIFY"] = "1";
    }
    const outPath = join(this.dir, `${label}.ir.json`);
    const result = await compile(join(this.dir, "main.ts"), {
      outDir: join(this.dir, "out"),
      outPath,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return readFile(outPath, "utf8");
  }

  /** The units with a record in the last build, recorded or applied. */
  units: string[] = [];

  /** Builds with reuse, checks the IR against a build without it, and
   * returns the units whose stored records applied. A build in verify mode
   * follows and must give the same IR. */
  async build(): Promise<string[]> {
    const label = `build-${this.builds++}`;
    const reused = await this.lower(label, true);
    expect(reused).toBe(await this.lower(`${label}-plain`, false));
    const applied: string[] = [];
    this.units = [];
    for (const line of (await readFile(join(this.dir, label, "records.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")) {
      // A unit without a record has a line with its reasons.
      const record = JSON.parse(line) as { name: string; applied?: boolean; reasons?: string[] };
      if (record.reasons !== undefined) continue;
      this.units.push(record.name);
      if (record.applied === true) applied.push(record.name);
    }
    this.units.sort();
    expect(await this.lower(`${label}-verify`, true, true)).toBe(reused);
    return applied.sort();
  }

  dispose(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }
}

const MODULES = {
  "shapes.ts": [
    "export function area(width: number, height: number): number {",
    "  return width * height;",
    "}",
    "export function label(name: string): string {",
    "  return `shape ${name}`;",
    "}",
    "export class Box {",
    "  constructor(readonly width: number) {}",
    "  scaled(by: number): number {",
    "    return this.width * by;",
    "  }",
    "  named(): string {",
    "    return label(`box ${this.width}`);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "report.ts": [
    'import { Box, area } from "./shapes.js";',
    "export function report(sizes: number[]): number {",
    "  let total = 0;",
    "  for (const size of sizes) total += area(size, size);",
    "  return total;",
    "}",
    "export function describe(box: Box): string {",
    "  return `${box.named()} ${box.scaled(2)}`;",
    "}",
    "export function twice(value: number): number {",
    "  return value * 2;",
    "}",
    "",
  ].join("\n"),
  "format.ts": [
    "export function pad(text: string, width: number): string {",
    "  return text.padStart(width);",
    "}",
    "",
  ].join("\n"),
  "main.ts": [
    'import { Box, label } from "./shapes.js";',
    'import { describe, report, twice } from "./report.js";',
    'import { pad } from "./format.js";',
    'console.log(report([1, 2, 3]), describe(new Box(4)), label("main"), twice(3), pad("x", 4));',
    "",
  ].join("\n"),
};

/** Whether `applied` holds a unit named `name`. */
const has = (applied: readonly string[], name: string): boolean =>
  applied.some((unit) => unit.endsWith(`.${name}`) || unit === name);

test("an unchanged rebuild applies every unit's stored record", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    // The first build into the cache records nothing; build()'s verify build
    // after it finds the tables and records.
    expect(await workspace.build()).toEqual([]);
    const units = workspace.units;
    expect(units.length).toBeGreaterThan(4);
    expect(await workspace.build()).toEqual(units);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("a body edit lowers the units of its file and the units that spell its name", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    await workspace.build();
    await workspace.edit("shapes.ts", "return width * height;", "return width * height + 1;");
    const applied = await workspace.build();
    // report() spells area(); twice() and pad() spell nothing whose
    // declaration changed. The units of shapes.ts lower again.
    expect(has(applied, "report")).toBe(false);
    expect(has(applied, "twice")).toBe(true);
    expect(has(applied, "pad")).toBe(true);
    expect(has(applied, "scaled")).toBe(false);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("a signature edit lowers the units whose text spells a name it reaches", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    await workspace.build();
    await workspace.edit(
      "shapes.ts",
      "  named(): string {",
      '  named(prefix = ""): string {\n    if (prefix !== "") return prefix;',
    );
    const applied = await workspace.build();
    // The member's surface changed, and with it the type of Box: the units
    // that spell named or Box lower again, the others apply.
    expect(has(applied, "named")).toBe(false);
    expect(has(applied, "report")).toBe(true);
    expect(has(applied, "twice")).toBe(true);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("an edit above every declaration of a file keeps the other files' units", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    await workspace.build();
    await workspace.edit(
      "shapes.ts",
      "export function area",
      "// A comment.\nexport function area",
    );
    const applied = await workspace.build();
    expect(has(applied, "report")).toBe(true);
    expect(has(applied, "twice")).toBe(true);
    expect(has(applied, "scaled")).toBe(false);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("an added declaration keeps the units that do not spell its name", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    await workspace.build();
    await workspace.edit(
      "report.ts",
      "export function describe",
      "export function unused(): number {\n  return 1;\n}\nexport function describe",
    );
    const applied = await workspace.build();
    expect(has(applied, "scaled")).toBe(true);
    expect(has(applied, "label")).toBe(true);
    expect(has(applied, "pad")).toBe(true);
    expect(has(applied, "twice")).toBe(false);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("units that use a module's namespace object lower again when its exports change", async () => {
  const workspace = await Workspace.create({
    "values.ts": "export let count = 1;\nexport function bump(): void {\n  count += 1;\n}\n",
    "main.ts": [
      'import * as values from "./values.js";',
      "function keys(): string {",
      '  return Object.keys(values).join(",");',
      "}",
      "function current(): number {",
      "  return values.count;",
      "}",
      "values.bump();",
      "console.log(keys(), current());",
      "",
    ].join("\n"),
  });
  try {
    await workspace.build();
    expect(await workspace.build()).toEqual(workspace.units);
    await workspace.write(
      "values.ts",
      "export let count = 1;\nexport function bump(): void {\n  count += 1;\n}\nexport const added = 2;\n",
    );
    // Both units spell the namespace binding, whose object gained a key.
    const applied = await workspace.build();
    expect(has(applied, "keys")).toBe(false);
    expect(has(applied, "current")).toBe(false);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("a unit whose record holds another file's positions lowers again when that file changes", async () => {
  const workspace = await Workspace.create({
    "lib.ts":
      'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport const label = "lib";\n',
    "main.ts": [
      'import * as lib from "./lib.js";',
      "function show(): string {",
      "  const { add: plus, label: name } = lib;",
      "  return `${name} ${plus(1, 2)}`;",
      "}",
      "function other(): number {",
      "  return 42;",
      "}",
      "console.log(show(), other());",
      "",
    ].join("\n"),
  });
  try {
    await workspace.build();
    await workspace.edit("lib.ts", "export function add", "// A comment.\nexport function add");
    // The build compares its IR, positions included, with a clean build's.
    const applied = await workspace.build();
    expect(has(applied, "other")).toBe(true);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("the first build into a cache writes the declaration tables and no unit records", async () => {
  const workspace = await Workspace.create(MODULES);
  try {
    const cache = join(workspace.dir, "cache");
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    process.env["SCRIPTC_INCR_LOWERING"] = "1";
    const build = async (): Promise<void> => {
      const result = await compile(join(workspace.dir, "main.ts"), {
        outDir: join(workspace.dir, "out"),
        outPath: join(workspace.dir, "main.ir.json"),
        outputKind: "ir",
      });
      expect(result.ok).toBe(true);
    };
    const entries = async (family: string): Promise<string[]> =>
      readdir(join(cache, "units-v1", family)).catch(() => []);
    await build();
    expect(await entries("program")).toHaveLength(1);
    expect(await entries("files")).toEqual([]);
    await build();
    expect((await entries("files")).length).toBeGreaterThan(0);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

const ALIASES = {
  "values.ts": [
    "export const limit: number = 3;",
    "export const unit = 2;",
    "export default function scale(value: number): number {",
    "  return value * unit;",
    "}",
    "export { unit as step };",
    "",
  ].join("\n"),
  "main.ts": [
    'import { limit as max, step } from "./values.js";',
    'import grow from "./values.js";',
    "function cap(value: number): string {",
    "  return `${value} of ${max}`;",
    "}",
    "function stepped(value: number): number {",
    "  return value + step;",
    "}",
    "function grown(value: number): number {",
    "  return grow(value);",
    "}",
    "console.log(cap(5), stepped(1), grown(4));",
    "",
  ].join("\n"),
};

test("a renamed import lowers again when its declaration's surface changes", async () => {
  const workspace = await Workspace.create(ALIASES);
  try {
    await workspace.build();
    await workspace.edit(
      "values.ts",
      "export const limit: number = 3;",
      'export const limit = "3";',
    );
    const applied = await workspace.build();
    expect(has(applied, "cap")).toBe(false);
    expect(has(applied, "grown")).toBe(true);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("an import of a renamed export or of a default export lowers again when its declaration changes", async () => {
  const workspace = await Workspace.create(ALIASES);
  try {
    await workspace.build();
    await workspace.edit("values.ts", "export const unit = 2;", "export const unit = 5;");
    let applied = await workspace.build();
    expect(has(applied, "stepped")).toBe(false);
    expect(has(applied, "cap")).toBe(true);
    await workspace.edit(
      "values.ts",
      "export default function scale(value: number): number {",
      "export default function scale(value: number, by = 1): number {",
    );
    applied = await workspace.build();
    expect(has(applied, "grown")).toBe(false);
    expect(has(applied, "cap")).toBe(true);
  } finally {
    await workspace.dispose();
  }
}, 300_000);

test("an import of an anonymous default export lowers again when its signature changes", async () => {
  const workspace = await Workspace.create({
    "values.ts": [
      "export default function (value: number): number {",
      "  return value * 2;",
      "}",
      "export function other(value: number): number {",
      "  return value + 1;",
      "}",
      "",
    ].join("\n"),
    "main.ts": [
      'import grow, { other } from "./values.js";',
      "function grown(value: number): number {",
      "  return grow(value);",
      "}",
      "function next(value: number): number {",
      "  return other(value);",
      "}",
      "console.log(grown(4), next(1));",
      "",
    ].join("\n"),
  });
  try {
    await workspace.build();
    await workspace.edit(
      "values.ts",
      "export default function (value: number): number {",
      "export default function (value: number, by = 1): number {",
    );
    const applied = await workspace.build();
    expect(has(applied, "grown")).toBe(false);
    expect(has(applied, "next")).toBe(true);
  } finally {
    await workspace.dispose();
  }
}, 300_000);
