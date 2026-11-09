import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("an untaken arm that declares a hoisted binding still lowers", async () => {
  expect(
    await paysForIntegrity(
      `${HELD}\nif (false) {\n  function freezeHeld(): void {\n    Object.freeze(held);\n  }\n  freezeHeld();\n}`,
    ),
  ).toBe(true);
});
