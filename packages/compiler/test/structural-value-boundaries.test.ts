import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

const nominal = `
class Row { left = 1; right = 2; }
const rows = [new Row()];
function choose(): string { return "left"; }
`;

test.each([
  [
    "optional nominal missing read",
    nominal + `console.log((rows[0] as unknown as { missing: number })["missing"]);`,
    "structural views of class instances",
  ],
  [
    "optional nominal missing write",
    nominal + `(rows[0] as unknown as { missing: number })["missing"] = 3;`,
    "structural views of class instances",
  ],
  [
    "optional nominal computed read",
    nominal + `console.log((rows[0] as unknown as Record<string, number>)[choose()]);`,
    "structural views of class instances",
  ],
  [
    "optional nominal computed write",
    nominal + `(rows[0] as unknown as Record<string, number>)[choose()] = 3;`,
    "structural views of class instances",
  ],
  [
    "nominal computed write",
    nominal + `(new Row() as unknown as Record<string, number>)[choose()] = 3;`,
    "structural views of class instances",
  ],
  [
    "getter-only structural write",
    `class Row { get value(): number { return 1; } }
    (new Row() as { value: number })["value"] = 2;`,
    "getter-only property",
  ],
  [
    "setter-only structural read",
    `class Row { set value(value: number) { console.log(value); } }
    console.log((new Row() as { value: number })["value"]);`,
    "only a setter",
  ],
  [
    "opaque optional class view cannot discard prototype accessors",
    nominal +
      `
    console.log((rows[0] as { left: unknown }).left);`,
    "opaque structural views",
  ],
  [
    "opaque record view cannot discard accessors",
    `
    const source = { get value(): number { return 1; } };
    console.log((source as { value: unknown }).value);`,
    "opaque structural views",
  ],
])(
  "%s reports a frontend refusal instead of selecting the wrong layout",
  (_name, source, message) => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-structural-refusal-"),
    );
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, source);
      const { coverage } = analyze(entry, {});
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.diagnostics).toContainEqual(
        expect.objectContaining({ code: "SC1090", message: expect.stringContaining(message) }),
      );
      expect(coverage.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a runtime-keyed spread into a record validates through a checked extraction", () => {
  const dir = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-structural-spread-"),
  );
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `const values: Record<string, unknown> = { value: 1 };
      const result: { value: number } = { ...values } as { value: number };
      console.log(result.value);`,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    // The spread copies the source's own enumerable keys into a
    // checked-dynamic object, and the assertion is a checked extraction:
    // a required field the runtime keys do not carry fails the conversion
    // instead of selecting a layout. The differential corpus (8502) pins
    // the copy's key order and values against Node.
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opaque class view keeps prototype accessors through the instance itself", () => {
  const dir = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-structural-view-"),
  );
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `class Row { get value(): number { return 1; } }
      const opaque = new Row() as { value: unknown }; console.log(opaque.value);`,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    // The view is the instance itself, so the build has no blocker; the
    // differential corpus (5767) pins the behavior against Node.
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
