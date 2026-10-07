import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(source = 'console.log("source output");\n') {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-source-output-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  await writeFile(entry, source);
  return { dir, entry, outDir };
}

test("serialized IR is the primary artifact and round-trips through validation", async () => {
  const { entry, outDir } = await fixture();
  const outPath = join(outDir, "custom.ir-data");
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  if (!result.ok) throw new Error("IR emission failed");
  expect(result.artifact).toEqual({ kind: "ir", path: outPath });
  const module = deserializeModule(await readFile(outPath, "utf8"));
  expect(validateModule(module)).toEqual([]);
});

test("Windows subsystem selection refuses non-executable compiler output", async () => {
  const { entry, outDir } = await fixture();
  const outPath = join(outDir, "main.ir.json");
  const result = await compile(entry, {
    outDir,
    outPath,
    outputKind: "ir",
    windowsSubsystem: "gui",
  });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "SC3002", message: expect.stringContaining("only supported for executable output") },
    ],
  });
  await expect(readFile(outPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("LLVM is the exact primary artifact and never creates an executable", async () => {
  const { entry, outDir } = await fixture();
  const llvmPath = join(outDir, "exact.llvm-output");
  const llvm = await compile(entry, { outDir, outPath: llvmPath, outputKind: "llvm" });
  if (!llvm.ok) throw new Error("LLVM emission failed");
  expect(llvm.artifact).toEqual({ kind: "llvm", path: llvmPath });
  expect(await readFile(llvmPath, "utf8")).toContain("define i32 @main");
  expect((await readdir(outDir)).sort()).toEqual(["exact.llvm-output"]);
});

test("switching default source output kinds preserves earlier generated siblings", async () => {
  const { entry, outDir } = await fixture();
  await mkdir(outDir, { recursive: true });
  const executable = process.platform === "win32" ? "main.exe" : "main";
  await writeFile(join(outDir, executable), "saved executable");
  const artifacts = [executable];
  for (const [kind, name] of [
    ["llvm", "main.ll"],
    ["ir", "main.ir.json"],
  ] as const) {
    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, name),
      outputKind: kind,
      defaultOutputPath: true,
    });
    if (!result.ok) throw new Error(`${kind} emission failed`);
    artifacts.push(name);
    expect((await readdir(outDir)).sort()).toEqual([...artifacts].sort());
  }
  expect(await readFile(join(outDir, executable), "utf8")).toBe("saved executable");
});

test("an explicit source path never deletes same-stem sibling files", async () => {
  const { entry, outDir } = await fixture();
  await mkdir(outDir, { recursive: true });
  const siblings = [
    join(outDir, "main"),
    join(outDir, "main.exe"),
    join(outDir, "main.wasm"),
    join(outDir, "main.c"),
    join(outDir, "main.ll"),
    join(outDir, "main.s"),
    join(outDir, "main.o"),
  ];
  await Promise.all(siblings.map((path) => writeFile(path, `caller-owned ${path}\n`)));
  const outPath = join(outDir, "main.ir.json");
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  expect(result.ok).toBe(true);
  for (const path of siblings) {
    await expect(readFile(path, "utf8")).resolves.toBe(`caller-owned ${path}\n`);
  }
});

test("an executable build never deletes same-stem assembly or object artifacts", async () => {
  const { entry, outDir } = await fixture();
  await mkdir(outDir, { recursive: true });
  const siblings = [join(outDir, "main.s"), join(outDir, "main.o")];
  await Promise.all(siblings.map((path) => writeFile(path, `caller-owned ${path}\n`)));
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "custom-executable"),
    backend: "llvm",
  });
  if (!result.ok) throw new Error("executable build failed");
  for (const path of siblings) {
    await expect(readFile(path, "utf8")).resolves.toBe(`caller-owned ${path}\n`);
  }
});

test.each([{ backend: "c" }, { outputKind: "c" }])(
  "removed C options reject before creating output: %s",
  async (removed) => {
    const { entry, outDir } = await fixture();
    // JavaScript callers may supply flags that are absent from the TypeScript API.
    const result = await compile(entry, { outDir, ...removed } as never);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "SC3002", message: expect.stringContaining("LLVM is the only backend") },
      ],
    });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("TLS callback programs emit LLVM without a secondary backend", async () => {
  const entry = join(
    import.meta.dirname,
    "../../../tests/fixtures/server/cases/tls-connect-basic/main.ts",
  );
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-source-tls-"));
  dirs.push(outDir);
  const outPath = join(outDir, "main.ll");
  const result = await compile(entry, { outDir, outPath, outputKind: "llvm" });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  expect(result.artifact).toEqual({ kind: "llvm", path: outPath });
  expect(await readFile(outPath, "utf8")).toContain("@scr_tls_connect");
  expect(await readdir(outDir)).toEqual(["main.ll"]);
});

test("source outputs ignore invalid external compiler selection and create no executable cache", async () => {
  const { dir, entry, outDir } = await fixture();
  const oldCc = process.env["SCRIPTC_CC"];
  const oldCache = process.env["SCRIPTC_CACHE_DIR"];
  const cache = join(dir, "must-not-exist");
  process.env["SCRIPTC_CC"] = "trap-compiler";
  process.env["SCRIPTC_CACHE_DIR"] = cache;
  try {
    for (const [kind, name] of [
      ["ir", "main.ir.json"],
      ["llvm", "main.ll"],
    ] as const) {
      const result = await compile(entry, {
        outDir,
        outPath: join(outDir, name),
        outputKind: kind,
      });
      expect(result.ok).toBe(true);
    }
    await expect(readdir(cache)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = oldCc;
    if (oldCache === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCache;
  }
});

test.each(["wasm64-wasi", "totally-invalid"])(
  "source output rejects unsupported target %s without writing an artifact",
  async (target) => {
    const { entry, outDir } = await fixture();
    const outPath = join(outDir, "main.ll");
    const oldTarget = process.env["SCRIPTC_TARGET"];
    const oldCc = process.env["SCRIPTC_CC"];
    process.env["SCRIPTC_TARGET"] = target;
    process.env["SCRIPTC_CC"] = "trap-compiler";
    try {
      const result = await compile(entry, { outDir, outPath, outputKind: "llvm" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "SC3002", message: expect.stringContaining(target) }),
      ]);
      await expect(readFile(outPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
      if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = oldCc;
    }
  },
);

test("default sort refuses erased results that may hide a comparator", async () => {
  const { entry, outDir } = await fixture(`
const erased: () => void = () => (a: number, b: number) => a - b;
const values = [2, 10, 1];
values.sort(erased() as undefined);
`);
  const result = await compile(entry, { outDir, outputKind: "llvm" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "SC2020",
      message: expect.stringContaining("erased comparator result"),
      hint: expect.stringContaining("void expression"),
    }),
  ]);
});
