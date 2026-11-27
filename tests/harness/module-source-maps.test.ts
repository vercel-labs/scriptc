/* node:module's source-map support where a compiled program and Node differ
 * by design: Node parses the source map a module's footer names once support
 * is enabled, so findSourceMap answers the parsed map. A compiled program
 * loads no JavaScript and parses no footer, so it answers undefined. The
 * corpus programs module-source-maps-* pin everything the two agree on. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// The footer is spelled in two pieces so a bundler reading this file does not
// treat it as a source-map link for the test itself.
const SIBLING = `export const x = 1;
//${"# sourceMappingURL=sibling.mjs.map"}
`;
const SIBLING_MAP = JSON.stringify({
  version: 3,
  file: "sibling.mjs",
  sources: ["sibling.ts"],
  sourcesContent: ["export const x = 1;"],
  names: [],
  mappings: "AAAA",
});
test("findSourceMap answers undefined where Node parsed a module's source map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-module-source-maps-"));
  const entry = join(dir, "main.mjs");
  const sibling = join(dir, "sibling.mjs");
  writeFileSync(
    entry,
    `
import { findSourceMap, setSourceMapsSupport } from "node:module";
setSourceMapsSupport(true);
const mod = await import("./sibling.mjs");
console.log(mod.x, JSON.stringify(findSourceMap(${JSON.stringify(sibling)}) === undefined));
`,
  );
  writeFileSync(sibling, SIBLING);
  writeFileSync(join(dir, "sibling.mjs.map"), SIBLING_MAP);
  const result = await compile(entry, {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize: process.env["SCRIPTC_SAN"] === "1",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  // Node parses the map the footer names and answers the SourceMap object.
  const oracle = await execFileAsync(process.execPath, [entry], { cwd: dir });
  expect(oracle.stdout).toBe("1 false\n");
  const native = await execFileAsync(result.binaryPath, [], { cwd: dir });
  expect(native.stderr).toBe("");
  expect(native.stdout).toBe("1 true\n");
});
