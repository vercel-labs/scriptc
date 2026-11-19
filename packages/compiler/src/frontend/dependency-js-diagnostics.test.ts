import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

/** The diagnostics a project's tsc would not report for a dependency's
 * shipped JavaScript. A JavaScript file the project's `files`/`include` does
 * not name is a dependency (a vendored package, a module reached only by
 * import): tsc compiles it as an external library and reports its checker
 * diagnostics only when the module itself asks (`// @ts-check`). The
 * project's `checkJs` is about the project's own JavaScript. */
function diagnostics(files: Record<string, string>): string[] {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-dependency-js-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const load = loadProgram(join(directory, "main.ts"));
  try {
    return checkPreflight(load).map((d) => `${d.code}: ${d.message.split("\n")[0]}`);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A project whose tsconfig names `include`, with the given compiler knobs. */
function program(include: readonly string[], checkJs?: true): Record<string, string> {
  return {
    "main.ts": 'import * as dependency from "./lib.js";\nconsole.log(dependency);\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        allowJs: true,
        ...(checkJs === true ? { checkJs: true } : {}),
      },
      include,
    }),
  };
}

/** Checker opinions only a checked JavaScript file reports: an implicit any
 * on a parameter, a property the class never declares, and a JSDoc tag the
 * parser cannot read (the `RenderTarget~Options` spelling in three.js). */
const dependency = `export class Texture { constructor() { this.isTexture = true; } }
/** @param {RenderTarget~Options} options */
export function describe(options) { return options.name; }
export function other() { const texture = new Texture(); return texture.isDataTexture; }
`;

test("a dependency's JavaScript reports no checker diagnostics", () => {
  // Not in the project's `include`: reached through the import, so it is a
  // dependency's shipped code, and tsc reports none of these.
  expect(diagnostics({ ...program(["*.ts"]), "lib.js": dependency })).toEqual([]);
});

test("a dependency's diagnostics stay when the module asks for them", () => {
  expect(
    diagnostics({ ...program(["*.ts"]), "lib.js": `// @ts-check\n${dependency}` }).length,
  ).toBeGreaterThan(0);
});

test("the project's own JavaScript keeps its checker diagnostics", () => {
  expect(
    diagnostics({ ...program(["*.ts", "*.js"]), "lib.js": dependency }).length,
  ).toBeGreaterThan(0);
});

test("checkJs checks the project's own JavaScript, not a dependency's", () => {
  // The project's own source: `checkJs` asks tsc for these errors.
  expect(
    diagnostics({ ...program(["*.ts", "*.js"], true), "lib.js": dependency }).length,
  ).toBeGreaterThan(0);
  // A dependency reached only through the import: `checkJs` does not reach it.
  expect(diagnostics({ ...program(["*.ts"], true), "lib.js": dependency })).toEqual([]);
});

test("a dependency's parse errors and unlowered constructs still report", () => {
  // A parse error leaves no AST for the lowering to compile.
  expect(
    diagnostics({ ...program(["*.ts"]), "lib.js": "export function broken( {\n" }).length,
  ).toBeGreaterThan(0);
  // TS2416: a subclass member whose type differs from its base's. An
  // override that reads `arguments` has no checked-dynamic family slot, so
  // the triage table refuses it, and the refusal survives the dependency
  // stance.
  const overrides = `export class Base { /** @returns {number} */ copy(source) { return 1; } }
export class Derived extends Base { copy(source) { return [source, arguments.length]; } }
`;
  expect(diagnostics({ ...program(["*.ts"]), "lib.js": overrides }).length).toBeGreaterThan(0);
});
