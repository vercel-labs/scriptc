import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

/** Compiles a JavaScript program whose statements catch their own refusals
 * and returns what it prints. */
async function run(name: string, source: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-cjs-binding-refusals-"));
  const entry = join(outDir, name);
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
  if (!result.ok) return "";
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  expect(stderr).toBe("");
  return stdout;
}

const ATTEMPT = `
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.name, error.code, error.message.split(" [")[0]); }
}
`;

// The CommonJS module object is a handle (a number) where its type is known.
// Node holds the object in every position, so a position that would hold the
// number instead is refused by name; members, typeof, comparisons and
// truthiness answer as in Node.
test("the CommonJS module object in an untyped position is refused by name", async () => {
  const refused =
    "Error SC1090 the CommonJS 'module' object as a value in an untyped position (its members, typeof, and comparisons such as require.main === module lower; an untyped use would see a number where Node has the object) is not supported yet";
  const stdout = await run(
    "main.cjs",
    `${ATTEMPT}
function kind(value) {
  return typeof value;
}
attempt("typeof", () => typeof module);
attempt("member", () => module.id + " " + typeof module.loaded);
attempt("main", () => require.main === module);
attempt("truthy", () => (module ? "yes" : "no"));
attempt("argument", () => kind(module));
attempt("string", () => String(module));
attempt("template", () => \`\${module}\`);
attempt("concatenation", () => module + "");
attempt("in", () => "exports" in module);
attempt("held", () => {
  const held = module;
  return held === module;
});
attempt("returned", () => kind((() => module)()));
`,
  );
  expect(stdout.split("\n")).toEqual([
    "typeof object",
    "member . boolean",
    "main true",
    "truthy yes",
    `argument ${refused}`,
    `string ${refused}`,
    `template ${refused}`,
    `concatenation ${refused}`,
    `in ${refused}`,
    `held ${refused}`,
    `returned ${refused}`,
    "",
  ]);
});

// The CommonJS module bindings are variables of each module, not properties
// of the global object. Destructuring one from it binds undefined in Node,
// in a CommonJS module and in an ES module; the binding's slot has the type
// the declaration gives the name and cannot hold that, so the destructuring
// is refused by name. The global object's own members destructure.
for (const extension of ["mjs", "cjs"]) {
  test(`a CommonJS binding destructured from the global object is refused by name (.${extension})`, async () => {
    const refused = (name: string): string =>
      `Error SC1031 destructuring '${name}' from the global object (Node binds undefined: the CommonJS module bindings are variables of each module, not properties of the global object) is not supported yet`;
    const stdout = await run(
      `main.${extension}`,
      `${ATTEMPT}
attempt("require", () => {
  const { require: load } = globalThis;
  return typeof load;
});
attempt("module", () => {
  const { module: record } = globalThis;
  return typeof record;
});
attempt("exports", () => {
  const { exports: table } = globalThis;
  return typeof table;
});
attempt("__filename", () => {
  const { __filename: file } = globalThis;
  return typeof file;
});
attempt("__dirname", () => {
  const { __dirname: directory } = global;
  return typeof directory;
});
attempt("a global", () => {
  const { parseInt: parse } = globalThis;
  return parse("7");
});
`,
    );
    expect(stdout.split("\n")).toEqual([
      `require ${refused("require")}`,
      `module ${refused("module")}`,
      `exports ${refused("exports")}`,
      `__filename ${refused("__filename")}`,
      `__dirname ${refused("__dirname")}`,
      "a global 7",
      "",
    ]);
  });
}
