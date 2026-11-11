/* In a JavaScript source, `typeof` of a name no declaration binds is the
 * global object's answer at run time — but only if the program can have
 * given the global object that property. The program-wide census of
 * global-object writes (global-object-writes.ts) answers that question, so a
 * name nothing writes keeps its static answer and the guard around a feature
 * the target does not have costs nothing. three.js's
 * `typeof __THREE_DEVTOOLS__ !== "undefined"` guard is the case that reached
 * the EventTarget surface in library mode when every such read lowered at
 * run time. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const BINDING_CALLS = /"fn":"global\.binding(?:Read|Value|Has)"/;

/** The lowered IR text of a program whose entry is `entry` (default `main.mjs`). */
async function irOf(files: Record<string, string>, entry = "main.mjs"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-global-typeof-fold-"));
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
    const out = join(dir, ".scriptc", `${entry}.ir.json`);
    const result = await compile(join(dir, entry), {
      outDir: join(dir, ".scriptc"),
      outPath: out,
      outputKind: "ir",
    });
    expect(result.ok ? [] : result.diagnostics.map((diag) => diag.message)).toEqual([]);
    return await readFile(out, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const GUARD = `if (typeof __featureProbe__ !== "undefined") console.log(__featureProbe__.value);
console.log(typeof __featureProbe__, typeof __featureProbe__ === "function");
`;

test("a name the program never writes on the global object keeps its static typeof", async () => {
  const ir = await irOf({ "main.mjs": GUARD });
  expect(BINDING_CALLS.test(ir)).toBe(false);
});

test("a name this module writes on the global object is a runtime typeof", async () => {
  const ir = await irOf({ "main.mjs": `${GUARD}globalThis.__featureProbe__ = { value: 1 };\n` });
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

test("a name another module writes on the global object is a runtime typeof", async () => {
  const ir = await irOf({
    "main.mjs": `import "./install.mjs";\n${GUARD}`,
    "install.mjs": `globalThis.__featureProbe__ = { value: 1 };\n`,
  });
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

test("an own property installed by defineProperty marks the name written", async () => {
  const ir = await irOf({
    "main.mjs": `${GUARD}Object.defineProperty(globalThis, "__featureProbe__", { value: 1 });\n`,
  });
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

test("an assignment by a computed key can name the property", async () => {
  const ir = await irOf({
    "main.mjs": `${GUARD}const key = "__featureProbe__";\nglobalThis[key] = { value: 1 };\n`,
  });
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

test("a sloppy-mode this write can land on the global object", async () => {
  // The source never spells `globalThis` or `global`: the write is the one
  // spelling of a global-object write that does not, and the census has to
  // read the source for it anyway.
  const ir = await irOf(
    {
      "main.js": `function install() { this.__featureProbe__ = { value: 1 }; }\ninstall();\nconsole.log(typeof __featureProbe__);\n`,
    },
    "main.js",
  );
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

test("a sloppy-mode this write by a computed key can name any property", async () => {
  const ir = await irOf(
    {
      "main.js": `function install(key) { this[key] = { value: 1 }; }\ninstall("__otherProbe__");\nconsole.log(typeof __featureProbe__);\n`,
    },
    "main.js",
  );
  expect(BINDING_CALLS.test(ir)).toBe(true);
});

/** A script-style declaration file: the globals it declares exist only as
 * types, so a bare reference to one is Node's read of the global object. */
const DECLARED_GLOBALS = `interface Doc { label: string }
declare var document: Doc;
declare const untouched: string;
`;

test("a declared global the program never writes keeps its static read", async () => {
  const ir = await irOf(
    {
      "main.ts": `/// <reference path="./globals.d.ts" />
console.log(document.label);
console.log(typeof untouched);
`,
      "globals.d.ts": DECLARED_GLOBALS,
    },
    "main.ts",
  );
  expect(BINDING_CALLS.test(ir)).toBe(false);
  expect(/"fn":"global\.undefRead"/.test(ir)).toBe(true);
});

test("a declared global the program writes on the global object is a runtime read", async () => {
  const ir = await irOf(
    {
      "main.ts": `/// <reference path="./globals.d.ts" />
(globalThis as any).document = { label: "installed" };
console.log(document.label, typeof document);
`,
      "globals.d.ts": DECLARED_GLOBALS,
    },
    "main.ts",
  );
  expect(/"fn":"global\.bindingRead"/.test(ir)).toBe(true);
  expect(/"fn":"global\.bindingValue"/.test(ir)).toBe(true);
});

test("a `declare global` block's binding is read the same way", async () => {
  const ir = await irOf(
    {
      "main.ts": `/// <reference path="./globals.d.ts" />
(globalThis as any).document = { label: "installed" };
console.log(document.label);
`,
      "globals.d.ts": `export {};
interface Doc { label: string }
declare global {
  const document: Doc;
}
`,
    },
    "main.ts",
  );
  expect(/"fn":"global\.bindingRead"/.test(ir)).toBe(true);
});
