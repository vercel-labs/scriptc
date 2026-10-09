import { expect, test } from "vitest";
import type { ScrDiagnostic } from "./diagnostic.js";
import { SourceLocator, buildEnvelope, categoryOf, groupDiagnostics, hintOf } from "./envelope.js";

const diag = (
  code: `SC${number}`,
  message: string,
  start: number,
  extra: Partial<ScrDiagnostic> = {},
): ScrDiagnostic => ({
  code,
  message,
  loc: { file: "/src/main.ts", start, end: start + 3 },
  ...extra,
});

test("instantiations of one component fence share a root-cause group", () => {
  const source = "a\nbb\nccc\n";
  const locator = new SourceLocator(new Map([["/src/main.ts", source]]));
  const { groups, located } = groupDiagnostics(
    [
      diag(
        "SC2009",
        "values of type 'Box<number>' cannot be compiled: member 'load' of 'Loader<number>' does not compile",
        5,
      ),
      diag(
        "SC2009",
        "values of type 'Map<string, Box<string>>' cannot be compiled: member 'load' of 'Loader<string>' does not compile",
        2,
      ),
      diag("SC1090", "spreading unions is not supported yet", 0),
    ],
    "reached",
    locator,
  );
  expect(groups).toHaveLength(2);
  expect(groups[0]!.message).toBe("member 'load' of 'Loader<…>' does not compile");
  expect(groups[0]!.count).toBe(2);
  // Sites in source order; the first is the primary location.
  expect(groups[0]!.sites.map((s) => [s.line, s.column])).toEqual([
    [2, 1],
    [3, 1],
  ]);
  expect(groups[0]!.primary).toEqual({ file: "/src/main.ts", line: 2, column: 1 });
  expect(located[2]).toMatchObject({ line: 1, column: 1, endLine: 2, endColumn: 2 });
  expect(located[2]!.group).toBe(groups[1]!.id);
});

test("every diagnostic carries a category and a hint", () => {
  expect(categoryOf(diag("SC6001", "copy", 0))).toBe("divergence");
  expect(categoryOf(diag("SC2012", "engine", 0))).toBe("dynamic-only");
  expect(categoryOf(diag("SC0001", "TS error", 0))).toBe("invalid-source");
  expect(categoryOf(diag("SC0001", "TS error", 0, { typeWorld: true }))).toBe("environment");
  expect(categoryOf(diag("SC9001", "ice", 0))).toBe("internal");
  expect(categoryOf(diag("SC1090", "form", 0))).toBe("unsupported");
  for (const code of [
    "SC1090",
    "SC1031",
    "SC2001",
    "SC2003",
    "SC0001",
    "SC9001",
    "SC3002",
  ] as const)
    expect(hintOf(diag(code, "m", 0)).length).toBeGreaterThan(0);
  expect(hintOf(diag("SC1090", "m", 0, { hint: "specific" }))).toBe("specific");
});

test("the build envelope reports the phase that stopped the build", () => {
  const sources = new Map([["/src/main.ts", "let x = 1;\n"]]);
  const failed = buildEnvelope({
    compilerVersion: "0.0.0",
    entry: "/src/main.ts",
    ok: false,
    diagnostics: [diag("SC1090", "form is not supported yet", 4)],
    sourceTexts: sources,
  });
  expect(failed).toMatchObject({
    schema: "scriptc-diagnostics",
    schemaVersion: 1,
    command: "build",
    success: false,
    phase: "compile",
  });
  expect(failed.diagnostics[0]).toMatchObject({
    severity: "error",
    scope: "reached",
    line: 1,
    column: 5,
  });
  const preflight = buildEnvelope({
    compilerVersion: "0.0.0",
    entry: "/src/main.ts",
    ok: false,
    diagnostics: [diag("SC0001", "Cannot find name 'y'.", 0)],
    sourceTexts: sources,
  });
  expect(preflight.phase).toBe("preflight");
  expect(preflight.diagnostics[0]!.scope).toBe("preflight");
  const ok = buildEnvelope({
    compilerVersion: "0.0.0",
    entry: "/src/main.ts",
    ok: true,
    artifact: "/out/main",
    diagnostics: [],
    warnings: [diag("SC6002", "order", 0)],
    sourceTexts: sources,
  });
  expect(ok).toMatchObject({ success: true, phase: "complete", artifact: "/out/main" });
  expect(ok.diagnostics[0]).toMatchObject({ category: "divergence", severity: "warning" });
});
