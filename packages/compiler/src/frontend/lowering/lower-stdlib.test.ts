/* The npm member fence is the last word on a member read no lowering
 * claimed: is this data the program holds, or a value only a package's
 * implementation could produce? A receiver typed by a package data shape is
 * data. So is a member that a package data shape declares, read through a
 * type the program spells around that shape. The checker keeps the member's
 * symbol in a spread copy, so `{ ...value.scale }.unit` carries the
 * package's provenance on the member alone; when the copied value came out
 * of a Node island the copy has no record layout, the read reaches the
 * fence, and the fence used to name the package. A member of a package
 * VALUE shape stays refused through the same copy. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyze } from "../../index.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DECLARATIONS = [
  // A data shape: an interface and nothing merged into it.
  "export interface Scale { unit: string; step?: number }",
  // An interface with a value declaration merged into it.
  "export interface Dial { unit: string }",
  "export declare const Dial: { make(unit: string): Dial };",
  // Value shapes: classes with a constructor and a method.
  "export declare class Needle { angle: number; constructor(); turn(): void }",
  "export declare class Gauge {",
  "  label: string;",
  "  scale?: Scale;",
  "  dial?: Dial;",
  "  needle?: Needle;",
  "  constructor(label: string);",
  "  read(): number;",
  "}",
  "export declare function makeGauge(label: string): Gauge;",
].join("\n");

const IMPLEMENTATION = [
  "class Needle {",
  "  constructor() { this.angle = 0; }",
  "  turn() { this.angle += 1; }",
  "}",
  "class Gauge {",
  "  constructor(label) {",
  "    this.label = label;",
  '    this.scale = { unit: "mm", step: 2 };',
  '    this.dial = { unit: "deg" };',
  "    this.needle = new Needle();",
  "  }",
  "  read() { return 1; }",
  "}",
  "exports.Needle = Needle;",
  "exports.Gauge = Gauge;",
  "exports.Dial = { make: (unit) => ({ unit }) };",
  "exports.makeGauge = (label) => new Gauge(label);",
].join("\n");

/** The lines of `source` (1-based) at which one lowering refuses a read as
 * reaching into the package `gauge-kit`, which runs in a Node island. */
function refusedLines(source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-member-fence-"));
  scratch.push(dir);
  const root = join(dir, "node_modules", "gauge-kit");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "gauge-kit", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(root, "index.d.ts"), `${DECLARATIONS}\n`);
  writeFileSync(join(root, "index.js"), `${IMPLEMENTATION}\n`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "member-fence",
      private: true,
      type: "module",
      scriptc: { packages: { "gauge-kit": "node" } },
    }),
  );
  writeFileSync(join(dir, "main.ts"), source);
  const result = analyze(join(dir, "main.ts"));
  const lines = result.coverage.diagnostics
    .filter((d) => d.code === "SC2013" && d.message.includes("'gauge-kit'"))
    .map((d) => source.slice(0, d.loc.start).split("\n").length);
  return [...new Set(lines)].sort((a, b) => a - b);
}

const program = (...lines: string[]): string =>
  [`import { makeGauge } from "gauge-kit";`, `const gauge = makeGauge("a");`, ...lines, ``].join(
    "\n",
  );

test("a data shape's member reads through a spread copy of an island value", () => {
  expect(
    refusedLines(
      program(
        `const held = { scale: gauge.scale && { ...gauge.scale } };`,
        `console.log(held.scale && held.scale.unit, held.scale && held.scale.step);`,
      ),
    ),
  ).toEqual([]);
});

test("a value shape's member stays refused through a spread copy", () => {
  expect(
    refusedLines(
      program(
        `const held = { needle: gauge.needle && { ...gauge.needle } };`,
        `console.log(held.needle && held.needle.angle);`,
      ),
    ),
  ).toEqual([4]);
});

test("a member of an interface merged with a value declaration stays refused", () => {
  expect(
    refusedLines(
      program(
        `const held = { dial: gauge.dial && { ...gauge.dial } };`,
        `console.log(held.dial && held.dial.unit);`,
      ),
    ),
  ).toEqual([4]);
});
