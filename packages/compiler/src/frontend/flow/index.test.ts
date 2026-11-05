import { createRequire } from "node:module";
import { expect, test } from "vitest";
import {
  flowPresentedSource,
  flowTranslationFailures,
  hasFlowPragma,
  setFlowSources,
} from "./index.js";

test("a Flow module is marked by @flow or @noflow in its leading comments", () => {
  expect(hasFlowPragma("// @flow\nexport const a = 1;")).toBe(true);
  expect(hasFlowPragma("/**\n * @flow strict\n */\nexport const a = 1;")).toBe(true);
  expect(hasFlowPragma("#!/usr/bin/env node\n/* @noflow */\nexport const a = 1;")).toBe(true);
  // A license longer than any fixed scan window comes first.
  expect(hasFlowPragma(`/* ${"license text ".repeat(1000)} */\n// @flow\nexport {};`)).toBe(true);
});

test("other mentions of flow are not the pragma", () => {
  expect(hasFlowPragma("// No pragma: plain JavaScript.\nexport const a = 1;")).toBe(false);
  expect(hasFlowPragma("// @flowtype annotations elsewhere\nexport {};")).toBe(false);
  expect(hasFlowPragma("// see @flow.org for details\nexport {};")).toBe(false);
  expect(hasFlowPragma("export const a = 1;\n// @flow\n")).toBe(false);
});

const hermes = createRequire(import.meta.url)("hermes-parser") as {
  parse(text: string, options: object): never;
};

test("a Flow syntax error is reported where it is, after text of any width", () => {
  for (const text of ['"aaaaa"', '"ééééé"', '"😀😀"']) {
    const source = `// @flow\nconst s = ${text}; const = 1;\n`;
    const files = new Map([["/p/m.js", source]]);
    setFlowSources(
      {},
      (t) => hermes.parse(t, { flow: "all", sourceType: "module", tokens: false }),
      (path) => files.get(path) ?? null,
      (path) => files.has(path),
    );
    flowPresentedSource("/p/m.ts");
    const [diagnostic] = flowTranslationFailures().diagnostics;
    expect(diagnostic?.code).toBe("SC0001");
    expect(diagnostic?.loc.start).toBe(source.indexOf("= 1"));
  }
  setFlowSources(
    null,
    undefined,
    () => null,
    () => false,
  );
});

test("a Flow module that does not translate is reported at its source", () => {
  const files = new Map([["/p/m.js", "// @flow\nexport const a = 1;\n"]]);
  const read = (path: string): string | null => files.get(path) ?? null;
  const exists = (path: string): boolean => files.has(path);
  // A translator failure that is not about the source: SC9001.
  const malformed = {
    type: "Program",
    range: [0, 0],
    body: [{ type: "TypeAlias", range: [0, 0] }],
  };
  setFlowSources({}, () => malformed as never, read, exists);
  expect(flowPresentedSource("/p/m.ts")).toBe("export {};\n");
  expect(flowTranslationFailures().diagnostics.map((d) => [d.code, d.loc.file])).toEqual([
    ["SC9001", "/p/m.js"],
  ]);
  // A client without a Flow parser: every Flow module is refused.
  setFlowSources({}, undefined, read, exists);
  flowPresentedSource("/p/m.ts");
  expect(flowTranslationFailures().diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC1090", "this scriptc client cannot parse Flow modules"],
  ]);
  setFlowSources(null, undefined, read, exists);
});
