import { expect, test } from "vitest";
import type { DiagnosticCode } from "./codes.js";
import type { ScrDiagnostic } from "./diagnostic.js";
import { allowedCodesAt, isStrictCode, strictErrors } from "./strict.js";

const loc = { file: "main.ts", start: 0, end: 1 };
const diag = (code: string, start = 0, severity?: "error" | "warning"): ScrDiagnostic => ({
  code: code as DiagnosticCode,
  message: code,
  loc: { ...loc, start },
  ...(severity === undefined ? {} : { severity }),
});

test("strict promotes the performance and copy findings, not key order", () => {
  expect(isStrictCode("SC6001")).toBe(true);
  expect(isStrictCode("SC6101")).toBe(true);
  expect(isStrictCode("SC6104")).toBe(true);
  expect(isStrictCode("SC6014")).toBe(false);
  expect(isStrictCode("SC8004")).toBe(false);
});

test("an allow comment names the codes on its line", () => {
  const text = [
    "const payload = JSON.parse(text); // scriptc-allow SC6101",
    "const copy = value; // scriptc-allow SC6001, SC6014",
    "const other = value; // just a comment",
    'const text2 = "// scriptc-allow SC6001";',
    "const plain = value;",
  ].join("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const at = (line: number): number => starts[line - 1]!;
  expect([...allowedCodesAt(text, at(1))]).toEqual(["SC6101"]);
  expect([...allowedCodesAt(text, at(2))]).toEqual(["SC6001", "SC6014"]);
  expect([...allowedCodesAt(text, at(3))]).toEqual([]);
  // A string that spells the comment is not a comment.
  expect([...allowedCodesAt(text, at(4))]).toEqual([]);
});

test("strictErrors promotes codes and honors the allow comment", () => {
  const source = "const w: W = x; // scriptc-allow SC6001\nconst n: N = w;";
  const sourceTexts = new Map([["main.ts", source]]);
  const errors = strictErrors(
    [diag("SC6001", 0), diag("SC6001", source.indexOf("const n")), diag("SC6014", 0)],
    sourceTexts,
  );
  expect(errors.map((d) => [d.code, d.severity, d.loc.start])).toEqual([
    ["SC6001", "error", source.indexOf("const n")],
  ]);
});

test("an island error is allowed only on its own import line", () => {
  const islandAt = (text: string): ScrDiagnostic => {
    const start = text.indexOf("import");
    return {
      code: "SC8001",
      severity: "error",
      message: "strict mode does not allow Node islands: copy-kit",
      loc: { file: "main.ts", start, end: start + 1 },
    };
  };
  const importLine = "import { kit } from 'copy-kit';";
  // A comment on the line above does not opt the island out.
  const above = ["// scriptc-allow SC8001", importLine].join("\n");
  expect(strictErrors([islandAt(above)], new Map([["main.ts", above]]))).toHaveLength(1);
  // On the import line it does.
  const onLine = `${importLine} // scriptc-allow SC8001`;
  expect(strictErrors([islandAt(onLine)], new Map([["main.ts", onLine]]))).toEqual([]);
});
