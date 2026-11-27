/* `export * from "<installed package>"`: import-plus-export plumbing, the
 * same admission named re-exports from a package already have. Importers
 * chase each name through the alias chain to the package's own
 * declarations, so the statement itself binds nothing and evaluates
 * nothing. A namespace re-export (`export * as ns`) still needs a namespace
 * object and keeps its fence. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

function diagnostics(files: Record<string, string>, entry: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-star-reexport-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const pkg = join(directory, "node_modules", "facade-pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    '{"name":"facade-pkg","version":"1.0.0","main":"index.js","types":"index.d.ts"}',
  );
  writeFileSync(join(pkg, "index.js"), "exports.a = 1;\nexports.b = 'b';\n");
  writeFileSync(join(pkg, "index.d.ts"), "export declare const a: number;\nexport declare const b: string;\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const load = loadProgram(join(directory, entry));
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a star re-export from an installed package is admitted", () => {
  expect(
    diagnostics(
      {
        "facade.ts": 'export * from "facade-pkg";\n',
        "main.ts": 'import { a, b } from "./facade";\nconsole.log(a, b);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a named re-export from an installed package stays admitted", () => {
  expect(
    diagnostics(
      {
        "facade.ts": 'export { a as renamed } from "facade-pkg";\n',
        "main.ts": 'import { renamed } from "./facade";\nconsole.log(renamed);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a namespace re-export from an installed package keeps its fence", () => {
  const result = diagnostics(
    {
      "facade.ts": 'export * as pkg from "facade-pkg";\n',
      "main.ts": 'import { pkg } from "./facade";\nconsole.log(pkg);\n',
    },
    "main.ts",
  );
  expect(result.some((d) => d.code === "SC1014")).toBe(true);
});
