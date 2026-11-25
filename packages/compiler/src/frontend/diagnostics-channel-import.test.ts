/* The diagnostics_channel import fact: which files can make a console call
 * publish, and the cheap answers that keep the program's library and
 * declaration files out of the walk. */
import { afterAll, expect, test } from "vitest";
import { sourceImportsDiagnosticsChannel } from "./diagnostics-channel-import.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";

afterAll(closeSourceParser);

function imports(name: string, source: string, kind: "js" | "ts" = "js"): boolean {
  return sourceImportsDiagnosticsChannel(parseSourceFile(name, source, kind));
}

test("an import, an export or a require of the module is the fact", () => {
  expect(imports("a.js", 'import { channel } from "node:diagnostics_channel";')).toBe(true);
  expect(imports("b.js", 'const { channel } = require("diagnostics_channel");')).toBe(true);
  expect(imports("c.ts", 'export * from "node:diagnostics_channel";')).toBe(true);
});

test("an escaped specifier is still found", () => {
  expect(imports("escaped-u.js", 'require("node:diagnostics\\u005fchannel");')).toBe(true);
  expect(imports("escaped-x.js", 'require("node:diagnostics\\x5fchannel");')).toBe(true);
  expect(imports("escaped-all.js", 'require("\\u006eode:diagnostics_channel");')).toBe(true);
});

test("a file that cannot name the module answers without the walk", () => {
  expect(imports("plain.js", "console.log(1);")).toBe(false);
  expect(
    imports("comment.js", "// diagnostics_channel is not imported here\nconsole.log(1);"),
  ).toBe(false);
  expect(imports("other.js", 'const fs = require("node:fs");')).toBe(false);
  expect(imports("computed.js", "const name = 'diagnostics_channel'; require(name);")).toBe(false);
});

test("a declaration file cannot run an import", () => {
  expect(
    imports(
      "node.d.ts",
      'declare module "node:diagnostics_channel" { export const channel: unknown; }',
      "ts",
    ),
  ).toBe(false);
});
