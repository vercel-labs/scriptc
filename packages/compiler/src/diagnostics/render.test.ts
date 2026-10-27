import { expect, test } from "vitest";
import type { ScrDiagnostic } from "./diagnostic.js";
import { renderDiagnostic, renderDiagnostics } from "./render.js";

function diag(file: string, start: number, end: number): ScrDiagnostic {
  return { code: "SC2020", message: "not supported", loc: { file, start, end } };
}

test("a short line renders whole", () => {
  const text = "const a = 1;\nconst b = a.c;\nconst d = 2;";
  const start = text.indexOf("a.c");
  expect(renderDiagnostic(diag("m.ts", start, start + 3), { text })).toBe(
    [
      "m.ts:2:11 - error SC2020: not supported",
      "",
      "  1 | const a = 1;",
      "  2 | const b = a.c;",
      "    |           ^~~",
      "  3 | const d = 2;",
    ].join("\n"),
  );
});

test("a long line renders a window around the column", () => {
  const line = "x".repeat(1000) + "bad" + "y".repeat(1000);
  const text = "first\n" + line + "\nlast";
  const start = text.indexOf("bad");
  const out = renderDiagnostic(diag("min.js", start, start + 3), { text });
  const lines = out.split("\n");
  expect(lines[0]).toBe("min.js:2:1001 - error SC2020: not supported");
  // the window starts 120 characters before the column
  expect(lines[3]).toBe(`  2 | …${"x".repeat(120)}bad${"y".repeat(277)}…`);
  expect(lines[4]).toBe(`    | ${" ".repeat(121)}^~~`);
  // context lines share the window: "first" and "last" start before it
  expect(lines[2]).toBe("  1 | …");
  expect(lines[5]).toBe("  3 | …");
});

test("a window at the line's end keeps the last characters", () => {
  const line = "a".repeat(600) + "end";
  const start = line.indexOf("end");
  const out = renderDiagnostic(diag("e.js", start, start + 3), { text: line });
  const lines = out.split("\n");
  expect(lines[2]).toBe(`  1 | …${"a".repeat(397)}end`);
  expect(lines[3]).toBe(`    | ${" ".repeat(398)}^~~`);
});

test("thousands of diagnostics on a minified line render without exhausting string length", () => {
  // one 2 MB line with 20,000 diagnostics: rendering every frame line whole
  // would need tens of gigabytes
  const text = "a;".repeat(1_000_000);
  const diags = Array.from({ length: 20_000 }, (_, i) => diag("bundle.js", i * 100, i * 100 + 1));
  const out = renderDiagnostics(diags, new Map([["bundle.js", text]]));
  expect(out.split(" - error SC2020: ").length - 1).toBe(20_000);
  expect(out.length).toBeLessThan(20_000 * 1_000);
});
