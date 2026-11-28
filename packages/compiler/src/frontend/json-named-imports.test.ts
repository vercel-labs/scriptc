/* JSON modules: named imports and named re-exports bake like the default
 * import. TypeScript's resolveJsonModule types the document's keys, and the
 * lowerer parses the document and emits the named binding as a record
 * global (collectJsonImports). Node's own ESM loader rejects a named import
 * from a JSON module, so this admission follows tsc and the project's
 * bundler, as the default JSON import already does (it is admitted without
 * Node's `with { type: "json" }` attribute). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

function diagnostics(files: Record<string, string>, entry: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-json-named-"));
  writeFileSync(
    join(directory, "package.json"),
    '{"type":"module","name":"probe","version":"1.2.3"}',
  );
  writeFileSync(join(directory, "data.json"), '{"name":"probe","version":"1.2.3","count":2}');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const load = loadProgram(join(directory, entry));
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a named JSON import is admitted", () => {
  expect(
    diagnostics(
      {
        "main.ts": 'import { name, count } from "./data.json";\nconsole.log(name, count + 1);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("an import renamed from a JSON property is admitted", () => {
  expect(
    diagnostics(
      {
        "main.ts": 'import { version as v } from "./data.json";\nconsole.log(v);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a named re-export from JSON is admitted through a consumer", () => {
  expect(
    diagnostics(
      {
        "pkg.ts": 'export { version } from "./data.json";\n',
        "main.ts": 'import { version } from "./pkg";\nconsole.log(version);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a named default import binds the whole document", () => {
  expect(
    diagnostics(
      {
        "main.ts": 'import { default as data } from "./data.json";\nconsole.log(data.name);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a default re-export from JSON is admitted through a consumer", () => {
  expect(
    diagnostics(
      {
        "pkg.ts": 'export { default } from "./data.json";\n',
        "main.ts": 'import { default as data } from "./pkg";\nconsole.log(data.version);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a string-literal export name from JSON is admitted", () => {
  // The exported name is arbitrary text; it must not reach the emitted
  // global's name (the compiler derives a safe one).
  expect(
    diagnostics(
      {
        "pkg.ts": 'export { version as "weird\\"name" } from "./data.json";\n',
        "main.ts": 'import { "weird\\"name" as v } from "./pkg";\nconsole.log(v);\n',
      },
      "main.ts",
    ),
  ).toEqual([]);
});

test("a namespace JSON import keeps its fence", () => {
  const result = diagnostics(
    {
      "main.ts": 'import * as data from "./data.json";\nconsole.log(data);\n',
    },
    "main.ts",
  );
  expect(result.some((d) => d.code === "SC1013")).toBe(true);
});
