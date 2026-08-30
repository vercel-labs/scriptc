import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type IrRecord = Record<string, unknown>;

function recordsOf(value: unknown, out: IrRecord[] = []): IrRecord[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) recordsOf(item, out);
    return out;
  }
  const record = value as IrRecord;
  out.push(record);
  for (const child of Object.values(record)) recordsOf(child, out);
  return out;
}

test("manifest-bound call initializers retain ffiCall IR and declaration storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-ffi-lowering-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, "main.ir.json");
  const profilePath = join(dir, "profile.json");
  await writeFile(
    entry,
    [
      "declare function nativeNumber(value: number): number;",
      "declare function nativeBoolean(value: boolean): boolean;",
      "const moduleConst = nativeNumber(1);",
      "let moduleLet = nativeBoolean(false);",
      "var moduleVar = nativeNumber(2);",
      "function localBindings() {",
      "  const localConst = nativeNumber(3);",
      "  let localLet = nativeBoolean(true);",
      "  var localVar = nativeNumber(4);",
      "  console.log(localConst, localLet, localVar);",
      "}",
      "localBindings();",
      "",
    ].join("\n"),
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        { name: "nativeNumber", symbol: "sf_number", params: ["f64"], returns: "f64" },
        { name: "nativeBoolean", symbol: "sf_boolean", params: ["bool"], returns: "bool" },
      ],
      libraries: [],
    }),
  );

  const result = await compile(entry, { outDir, outPath, outputKind: "ir", ffiProfilePath: profilePath });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
  }

  const module = deserializeModule(await readFile(outPath, "utf8"));
  expect(validateModule(module)).toEqual([]);

  const expectedGlobals = ["moduleConst", "moduleLet", "moduleVar"];
  const globals = module.globals ?? [];
  expect(globals.map((global) => global.name)).toEqual(expect.arrayContaining(expectedGlobals));
  const globalIds = new Set(
    globals.filter((global) => expectedGlobals.includes(global.name)).map((global) => global.id),
  );

  const localFn = module.functions.find((fn) => fn.name.endsWith("localBindings"));
  expect(localFn).toBeDefined();
  const expectedLocals = ["localConst", "localLet", "localVar"];
  const localIds = new Set(
    localFn!.locals.filter((local) => expectedLocals.includes(local.name)).map((local) => local.id),
  );
  expect(localIds.size).toBe(expectedLocals.length);

  const records = recordsOf(module);
  const ffiInitializers = (ids: ReadonlySet<string>) => records.filter((record) =>
    ((record.kind === "assign" && typeof record.localId === "string" && ids.has(record.localId) &&
      (record.value as IrRecord | undefined)?.kind === "ffiCall") ||
      (record.kind === "varDecl" && typeof record.localId === "string" && ids.has(record.localId) &&
      (record.init as IrRecord | undefined)?.kind === "ffiCall")),
  );
  expect(ffiInitializers(globalIds)).toHaveLength(expectedGlobals.length);
  expect(ffiInitializers(localIds)).toHaveLength(expectedLocals.length);

  const ffiCalls = records.filter((record) => record.kind === "ffiCall");
  expect(ffiCalls).toHaveLength(6);
  expect(records.some((record) => record.kind === "libCall" && record.fn === "global.undefRead")).toBe(false);
});
