import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

/** A checked JavaScript program whose JSX comes before the admitted site.
 * The rewrite inserts the runtime import and replaces the element, so every
 * offset after the first element moves by a different amount than the one
 * before it. */
function jsxProject(): { directory: string; file: string; source: string } {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-jsx-opinion-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        strict: true,
        jsx: "react-jsx",
        noEmit: true,
      },
    }),
  );
  writeFileSync(
    join(directory, "jsx-types.d.ts"),
    [
      "declare namespace JSX {",
      "  interface IntrinsicElements { div: any }",
      "}",
      'declare module "react/jsx-runtime" {',
      "  export const jsx: any;",
      "  export const jsxs: any;",
      "  export const Fragment: any;",
      "}",
      "",
    ].join("\n"),
  );
  const source = [
    '/// <reference path="./jsx-types.d.ts" />',
    'const box = <div className="box" />;',
    "export function pick(value) { return value; }",
    "export { box };",
    "",
  ].join("\n");
  const file = join(directory, "app.jsx");
  writeFileSync(file, source);
  return { directory, file, source };
}

test("an admitted opinion site is recorded at its span in the text the lowering holds", () => {
  const { directory, file } = jsxProject();
  const load = loadProgram(file);
  try {
    expect(checkPreflight(load)).toEqual([]);
    const lowered = load.jsxSources?.get(file);
    expect(lowered).toBeDefined();
    // The parameter's implicit any (TS7006) is admitted once: the world over
    // the text as written and the world over the rewritten text name the
    // same site, so the record is one entry, at the rewritten offset.
    const sites = (load.admittedOpinions ?? []).filter((site) => site.code === 7006);
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(lowered!.text.slice(site.pos, site.end)).toBe("value");
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a site with no JSX rewrite keeps its diagnostic offsets", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-opinion-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, strict: true, noEmit: true },
    }),
  );
  const source = "export function pick(value) { return value; }\n";
  const file = join(directory, "app.js");
  writeFileSync(file, source);
  const load = loadProgram(file);
  try {
    expect(checkPreflight(load)).toEqual([]);
    const sites = (load.admittedOpinions ?? []).filter((site) => site.code === 7006);
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(source.slice(site.pos, site.end)).toBe("value");
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
