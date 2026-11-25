import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

const CLASS = `
class Point {
  x = 1;
}
const p = new Point();
p.x = 2;
console.log(p.x);
`;

async function lowerProgram(
  files: Record<string, string>,
  define?: Record<string, string>,
): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-conditions-"));
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(join(dir, "main.ts"), {
      outDir: dir,
      outPath,
      outputKind: "ir",
      ...(define ? { define } : {}),
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether the program pays for integrity: the module flag, the hidden word
 * of the class and the check before its field write come and go together. */
async function paysForIntegrity(
  head: string,
  extra: Record<string, string> = {},
  define?: Record<string, string>,
): Promise<boolean> {
  const mod = await lowerProgram({ ...extra, "main.ts": `${head}\n${CLASS}` }, define);
  const point = (mod.classes ?? []).find((c) => c.name === "Point" || c.name.endsWith(".Point"));
  if (!point) throw new Error("no class Point");
  const word = point.fields.some((f) => f.name === "%attributes");
  const checked = JSON.stringify(mod.functions).includes(`"fn":"class.throwReadOnly"`);
  const flag = mod.untypedIntegrity === true;
  expect([word, checked]).toEqual([flag, flag]);
  return flag;
}

const HELD = `const held: unknown = { x: 1 };`;

test("a freeze of an untyped value that can run keeps the integrity word and the write checks", async () => {
  expect(await paysForIntegrity(`${HELD}\nObject.freeze(held);`)).toBe(true);
  expect(await paysForIntegrity(`${HELD}\nif (true) {\n  Object.freeze(held);\n}`)).toBe(true);
  expect(await paysForIntegrity(`${HELD}\nif (false) {\n} else {\n  Object.freeze(held);\n}`)).toBe(
    true,
  );
  expect(
    await paysForIntegrity(`const DEV = true;\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`),
  ).toBe(true);
});

test("a freeze under a condition that is false in every run costs the program nothing", async () => {
  expect(await paysForIntegrity(`${HELD}\nif (false) {\n  Object.freeze(held);\n}`)).toBe(false);
  expect(
    await paysForIntegrity(`const DEV = false;\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`),
  ).toBe(false);
  expect(
    await paysForIntegrity(
      `const PROD = true;\nconst DEV = !PROD;\n${HELD}\nif (DEV && held !== null) {\n  Object.seal(held);\n} else {\n  console.log("production");\n}`,
    ),
  ).toBe(false);
  expect(
    await paysForIntegrity(
      `const DEV = false;\n${HELD}\nDEV && Object.freeze(held);\n!DEV || Object.seal(held);`,
    ),
  ).toBe(false);
  expect(
    await paysForIntegrity(
      `import { DEV } from "./flags.ts";\n${HELD}\nif (DEV) {\n  Object.preventExtensions(held);\n}`,
      { "flags.ts": `export const DEV = false;\n` },
    ),
  ).toBe(false);
});

test("a binding that can hold another value does not decide a condition", async () => {
  expect(
    await paysForIntegrity(`let DEV = false;\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`),
  ).toBe(true);
  expect(
    await paysForIntegrity(
      `const DEV = process.argv.length > 9;\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`,
    ),
  ).toBe(true);
  expect(
    await paysForIntegrity(
      `function check(DEV: boolean): void {\n  if (DEV) {\n    Object.freeze(held);\n  }\n}\n${HELD}\ncheck(false);`,
    ),
  ).toBe(true);
  expect(await paysForIntegrity(`const DEV = false;\n${HELD}\nDEV || Object.freeze(held);`)).toBe(
    true,
  );
  expect(
    await paysForIntegrity(
      `const [DEV] = [false];\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`,
    ),
  ).toBe(true);
});

test("a comparison --define decides is constant, and an undefined one is not", async () => {
  const head = `${HELD}\nif (process.env.NODE_ENV !== "production") {\n  Object.freeze(held);\n}`;
  expect(await paysForIntegrity(head)).toBe(true);
  expect(await paysForIntegrity(head, {}, { "process.env.NODE_ENV": "production" })).toBe(false);
  expect(await paysForIntegrity(head, {}, { "process.env.NODE_ENV": "development" })).toBe(true);
  expect(
    await paysForIntegrity(
      `export const DEV = process.env.NODE_ENV !== "production";\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}`,
      {},
      { "process.env.NODE_ENV": "production" },
    ),
  ).toBe(false);
});

test("a conditional expression lowers only the arm a constant condition selects", async () => {
  expect(
    await paysForIntegrity(
      `const DEV = false;\n${HELD}\nconst kept = DEV ? Object.freeze(held) : held;\nconsole.log(kept === held);`,
    ),
  ).toBe(false);
  expect(
    await paysForIntegrity(
      `const DEV = false;\n${HELD}\nconsole.log(!DEV ? "production" : Object.seal(held));`,
    ),
  ).toBe(false);
  expect(
    await paysForIntegrity(
      `const DEV = true;\n${HELD}\nconst kept = DEV ? Object.freeze(held) : held;\nconsole.log(kept === held);`,
    ),
  ).toBe(true);
  expect(
    await paysForIntegrity(
      `let DEV = false;\n${HELD}\nconst kept = DEV ? Object.freeze(held) : held;\nconsole.log(kept === held);`,
    ),
  ).toBe(true);
  expect(
    await paysForIntegrity(
      `${HELD}\nconsole.log(process.env.NODE_ENV === "production" ? "production" : Object.freeze(held));`,
      {},
      { "process.env.NODE_ENV": "production" },
    ),
  ).toBe(false);
});

/** The body of the function `name`, without source positions. */
function bodyOf(mod: IrModule, name: string): string {
  const fn = mod.functions.find((f) => f.name === name || f.name.endsWith(`.${name}`));
  if (!fn) throw new Error(`no function ${name}`);
  return JSON.stringify(fn.body, (key, value: unknown) => (key === "loc" ? undefined : value));
}

test("a constant condition that can throw still evaluates, and the taken arm runs after it", async () => {
  const mod = await lowerProgram({
    "main.ts": `function early(): string {\n  if (LATE) {\n    return "then";\n  } else {\n    return LATE ? "selected" : "else";\n  }\n}\nconsole.log(early());\nconst LATE = false;\n`,
  });
  const text = bodyOf(mod, "early");
  // Both reads of LATE remain with their checks. The `if` is its taken arm
  // after its test; the conditional expression keeps both arms.
  expect(text.split(`"module.tdzCheck"`).length - 1).toBe(2);
  expect(text).not.toContain(`"value":"then"`);
  expect(text).not.toContain(`"kind":"if"`);
  expect(text).toContain(`"kind":"ternary"`);
  expect(text).toContain(`"value":"selected"`);
  expect(text).toContain(`"value":"else"`);
});

test("a folded condition is the code it selects, written alone", async () => {
  const helpers = `const DEV = false;
function dev(n: number): string {
  return "dev " + n;
}
function prod(n: number): string {
  return "prod " + n;
}
`;
  const calls = `console.log(text(1), mixed(), negated(2), statement(3), defined(4));\n`;
  const define = { "process.env.NODE_ENV": "production" };
  const folded = await lowerProgram(
    {
      "main.ts": `${helpers}
function text(n: number): string {
  return DEV ? dev(n) : prod(n);
}
function mixed(): string | number {
  return DEV ? 1 : "else";
}
function negated(n: number): string {
  const picked = !DEV ? prod(n) : dev(n);
  return picked;
}
function statement(n: number): string {
  if (DEV) {
    return dev(n);
  } else {
    return prod(n);
  }
}
function defined(n: number): string {
  if (process.env.NODE_ENV !== "production") {
    return dev(n);
  }
  return process.env.NODE_ENV === "production" ? prod(n) : dev(n);
}
${calls}`,
    },
    define,
  );
  const alone = await lowerProgram(
    {
      "main.ts": `${helpers}
function text(n: number): string {
  return prod(n);
}
function mixed(): string | number {
  return "else";
}
function negated(n: number): string {
  const picked = prod(n);
  return picked;
}
function statement(n: number): string {
  {
    return prod(n);
  }
}
function defined(n: number): string {
  {
  }
  return prod(n);
}
${calls}`,
    },
    define,
  );
  for (const name of ["text", "mixed", "negated", "statement", "defined"])
    expect(bodyOf(folded, name), name).toBe(bodyOf(alone, name));
});

test("a write through a computed name leaves the conditions --define decides to the run", async () => {
  const define = { "process.env.NODE_ENV": "production" };
  const name = `const name: string = ["NODE", "ENV"].join("_");`;
  const tail = `${HELD}\nif (process.env.NODE_ENV !== "production") {\n  Object.freeze(held);\n}\nconsole.log(process.env.NODE_ENV === "production" ? "production" : Object.seal(held));`;
  // Without such a write the conditions fold.
  expect(
    await paysForIntegrity(`${name}\nconsole.log(process.env[name]);\n${tail}`, {}, define),
  ).toBe(false);
  expect(await paysForIntegrity(`process.env["OTHER"] = "set";\n${tail}`, {}, define)).toBe(false);
  for (const write of [
    `process.env[name] = "development";`,
    `delete process.env[name];`,
    `console.log(delete process.env[name]);`,
    `const env = process.env;\nenv[name] = "development";`,
    `(process.env)[name] = "development";`,
    `function change(): void {\n  process.env[name] = "development";\n}`,
  ]) {
    expect(await paysForIntegrity(`${name}\n${write}\n${tail}`, {}, define), write).toBe(true);
    // A literal and a \`const\` decide as before.
    expect(
      await paysForIntegrity(
        `const DEV = false;\n${name}\n${write}\n${HELD}\nif (DEV) {\n  Object.freeze(held);\n}\nconsole.log(DEV ? Object.seal(held) : "production");`,
        {},
        define,
      ),
      write,
    ).toBe(false);
  }
  // A write in another module of the program counts.
  expect(
    await paysForIntegrity(
      `import "./change.ts";\n${tail}`,
      {
        "change.ts": `${name}\nprocess.env[name] = "development";\n`,
      },
      define,
    ),
  ).toBe(true);
});

/** Lowers the project `files` describes (paths below `dir`, entry
 * `main.ts`) and answers which of `texts` the lowered functions hold. */
async function textsKept(
  dir: string,
  files: Record<string, string>,
  define: Record<string, string>,
  texts: readonly string[],
): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), source);
    }
    const outPath = join(dir, "main.ir.json");
    const result = await compile(join(dir, "main.ts"), {
      outDir: dir,
      outPath,
      outputKind: "ir",
      define,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const functions = JSON.stringify(deserializeModule(await readFile(outPath, "utf8")).functions);
    return texts.filter((text) => functions.includes(JSON.stringify(text)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a program that runs code in Node.js leaves the conditions --define decides to the run", async () => {
  // Island code is the same process with the same environment, and the
  // build does not read its JavaScript: it can change the defined variable.
  const define = { "process.env.NODE_ENV": "production" };
  const texts = ["development branch", "development arm", "development operand", "never branch"];
  const conditions = [
    `if (process.env.NODE_ENV !== "production") {`,
    `  console.log("development branch");`,
    `}`,
    `console.log(process.env.NODE_ENV === "production" ? "production arm" : "development arm");`,
    `console.log(process.env.NODE_ENV === "production" || "development operand");`,
    `const NEVER = false;`,
    `if (NEVER) {`,
    `  console.log("never branch");`,
    `}`,
    ``,
  ].join("\n");
  const setter = `exports.setMode = (mode) => {\n  process.env.NODE_ENV = mode;\n};\n`;
  const followsTheRun = ["development branch", "development arm", "development operand"];
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-constant-conditions-island-"));
  // Without code in Node.js the define decides each condition.
  expect(await textsKept(scratch, { "main.ts": conditions }, define, texts)).toEqual([]);
  // A package that runs in a Node island: a literal and a `const` still decide.
  expect(
    await textsKept(
      scratch,
      {
        "package.json": JSON.stringify({
          name: "island-define",
          private: true,
          type: "module",
          scriptc: { packages: { "env-setter": "node" } },
        }),
        "node_modules/env-setter/package.json": JSON.stringify({
          name: "env-setter",
          version: "1.0.0",
          main: "index.js",
          types: "index.d.ts",
        }),
        "node_modules/env-setter/index.js": `"use strict";\n${setter}`,
        "node_modules/env-setter/index.d.ts": `export declare function setMode(mode: string): void;\n`,
        "main.ts": `import { setMode } from "env-setter";\nsetMode("development");\n${conditions}`,
      },
      define,
      texts,
    ),
  ).toEqual(followsTheRun);
  // The @scriptc/node API, which resolves from inside the repository.
  expect(
    await textsKept(
      join(import.meta.dirname, "../..", "node_modules/.cache/scriptc-tests/constant-conditions"),
      {
        "setter.cjs": setter,
        "main.ts": `import { callSync } from "@scriptc/node";\ncallSync("./setter.cjs", "setMode", "development");\n${conditions}`,
      },
      define,
      texts,
    ),
  ).toEqual(followsTheRun);
});

test("changing a variable --define fixes is refused in every form that names it", async () => {
  const define = { "process.env.NODE_ENV": "production" };
  const tail = `\nif (process.env.NODE_ENV !== "production") {\n  console.log("development");\n}\n`;
  for (const change of [
    `process.env.NODE_ENV = "development";`,
    `process.env["NODE_ENV"] = "development";`,
    `delete process.env.NODE_ENV;`,
    `console.log(delete process.env.NODE_ENV);`,
    `console.log(delete process.env["NODE_ENV"]);`,
    `const env = process.env;\nenv.NODE_ENV = "development";`,
  ]) {
    await expect(lowerProgram({ "main.ts": `${change}${tail}` }, define), change).rejects.toThrow(
      /SC1090: changing process\.env\.NODE_ENV when --define fixes its value/,
    );
  }
  // Another variable, and the same program without the define, build.
  await lowerProgram({ "main.ts": `process.env.OTHER = "changed";${tail}` }, define);
  await lowerProgram({ "main.ts": `process.env.NODE_ENV = "development";${tail}` });
});

test("an untaken arm that declares a hoisted binding still lowers", async () => {
  expect(
    await paysForIntegrity(
      `${HELD}\nif (false) {\n  function freezeHeld(): void {\n    Object.freeze(held);\n  }\n  freezeHeld();\n}`,
    ),
  ).toBe(true);
});
