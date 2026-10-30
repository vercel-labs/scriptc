/* Reflection that can install an accessor over an error's `name` or
 * `message`: a defineProperty call over a target that may hold an Error
 * turns on the accessor checks of typed Error reads and writes
 * (error-methods.ts), whatever the target parameter's declared type. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedIr(source: string): Promise<string> {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `error-accessor-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "main.ts");
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "main.ir"),
    outDir,
    outputKind: "ir",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

const program = (
  param: string,
  define = "Object.defineProperty",
): string => `class E extends Error {}
function install${param} {
  ${define}(target, "message", { get: () => "lazy", configurable: true });
}
const e = new E("orig");
install(e);
console.log(e.message);
`;

const checksAccessors = async (source: string): Promise<boolean> =>
  (await emittedIr(source)).includes("error.ownAccessor");

test.each([
  ["object", "(target: object)"],
  ["{}", "(target: {})"],
  ["Object", "(target: Object)"],
  ["a weak type", "(target: { message?: string })"],
  ["{ message: string }", "(target: { message: string })"],
  ["a type parameter", "<T>(target: T)"],
  ["a constrained type parameter", "<T extends object>(target: T)"],
  ["object | undefined", "(target: object | undefined)"],
  ["Error", "(target: Error)"],
  ["unknown", "(target: unknown)"],
])("a definition over %s checks for accessors", async (_, param) => {
  expect(await checksAccessors(program(param))).toBe(true);
});

test("Reflect.defineProperty over object checks for accessors", async () => {
  expect(await checksAccessors(program("(target: object)", "Reflect.defineProperty"))).toBe(true);
});

test("a definition over a type that cannot hold an Error leaves typed reads plain", async () => {
  const source = `class E extends Error {}
class Box {
  id = 0;
}
function install(target: Box) {
  Object.defineProperty(target, "extra", { get: () => 1, configurable: true });
}
install(new Box());
const e = new E("orig");
console.log(e.message);
`;
  expect(await checksAccessors(source)).toBe(false);
});
