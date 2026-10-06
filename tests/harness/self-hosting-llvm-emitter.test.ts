import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  compile,
  compileC,
  deserializeModule,
  serializeModule,
  validateModule,
} from "@scriptc/compiler";
import { emitLlvmModule } from "../../packages/compiler/src/backend/llvm/emitter.js";
import { type IrModule } from "../../packages/compiler/src/ir/ir.js";
import {
  moduleUsesAssert,
  moduleUsesBigInt,
  moduleUsesCopying,
  moduleUsesDynInvoke,
  moduleUsesEmitter,
  moduleUsesInspect,
  moduleUsesLegacyTextDecoder,
  moduleUsesRegex,
  moduleUsesStream,
  moduleUsesSymbol,
  moduleUsesZlib,
} from "../../packages/compiler/src/ir/runtime-features.js";
import {
  llvmEmitterCases,
  llvmEmitterOptions,
  llvmEmitterRequest,
  type LlvmEmitterRequest,
} from "./self-hosting-llvm-emitter-cases.js";
import { normalizedEmbeddingLlvm } from "./self-hosting-llvm-embedding.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/llvm-emitter.ts");
const execFileAsync = promisify(execFile);
const runOptions = { cwd: root, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 };
const sanitize = process.env["SCRIPTC_SAN"] === "1";

function programStderr(stderr: Buffer): string {
  const text = stderr.toString("utf8");
  return sanitize
    ? text.replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      )
    : text;
}

function nativeFeatures(mod: IrModule) {
  return {
    regex: moduleUsesRegex(mod),
    copying: moduleUsesCopying(mod),
    inspect: moduleUsesInspect(mod),
    dynInvoke: moduleUsesDynInvoke(mod),
    symbol: moduleUsesSymbol(mod),
    bigint: moduleUsesBigInt(mod),
    zlib: moduleUsesZlib(mod),
    assert: moduleUsesAssert(mod),
    emitter: moduleUsesEmitter(mod),
    stream: moduleUsesStream(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
  };
}

// Execute generated modules across expression dispatch, shared mutable
// emitter state, exception paths, dynamic walkers and callback adapters.
const programs = [
  "001-hello.ts",
  "101-arithmetic.ts",
  "600-closures-basic.ts",
  "711-inheritance-dispatch.ts",
  "756-cycle-inheritance.ts",
  "803-switch-rc-stress.ts",
  "1005-json-nested.ts",
  "1023-async-rc-stress.ts",
  "1401-typedarray-slice-set.ts",
  "1452-return-through-finally.ts",
  "1637-inspect-dyn.ts",
  "1672-symbol-containers.ts",
  "1726-promise-with-resolvers.ts",
  "2012-generators-return-throw.ts",
  "2537-destructuring-assign-member-targets.ts",
  "2840-finally-completions.ts",
  "2905-bigint-edges.ts",
  "3103-scalar-record-nested-control-flow.ts",
  "3104-native-analysis-tables-loops.ts",
  "3109-identity-union-collections.ts",
  "3112-union-switch-control-flow.ts",
  "3113-union-array-removal.ts",
  "3114-union-record-field-write.ts",
  "3115-zlib-static-compression-levels.ts",
  "3116-sequence-expression-lifetimes.ts",
  "3117-unknown-switch-control-flow.ts",
  "3118-recursive-union-spread.ts",
  "3119-runtime-optional-spread.ts",
  "3120-ir-nonfinite-numbers.ts",
  "4031-event-emitter-long-tuples.ts",
  "text-codec-values/main.ts",
  "string-split-traversal.ts",
  "heap-input-aliases.ts",
  "heap-input-collections.ts",
  "input-lifetime-intervals.ts",
  "regex-input-lifetimes.ts",
  "checked-value-input-lifetimes.ts",
  "checked-dispatch-input-lifetimes.js",
  "literal-switch-dispatch.ts",
  "local-union-storage.ts",
  "class-callback-storage.ts",
];

for (const backend of ["llvm"] as const) {
  test(`the complete LLVM emitter bootstraps natively (${backend})`, async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-llvm-emitter-"),
    );
    const executable = (name: string) =>
      join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    const stage = executable("emitter");
    const input = join(dir, "input.json");
    const output = join(dir, "native.ll");
    const config = join(dir, "config.json");
    try {
      // Lower the full production graph in a child so synchronous frontend
      // work cannot block Vitest's worker RPC while it compiles the seed.
      const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { compile } from ${JSON.stringify(api)};
         const result = await compile(process.argv[1], {
           outDir: process.argv[2], outPath: process.argv[3], backend: process.argv[4],
           dynamic: false, optimization: 'dev', sanitize: process.argv[5] === '1', emitIr: true,
         });
         console.log(JSON.stringify(result));`,
          entry,
          dir,
          stage,
          backend,
          sanitize ? "1" : "0",
        ],
        { ...runOptions, timeout: 600_000 },
      );
      const built = JSON.parse(stdout) as Awaited<ReturnType<typeof compile>>;
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      if (!("binaryPath" in built)) throw new Error("bootstrap did not produce an executable");
      expect(built.backend).toBe(backend);

      expect(built.irPath).toBeDefined();
      const ownIr = deserializeModule(readFileSync(built.irPath!, "utf8"));
      expect(ownIr.functions.length).toBeGreaterThan(800);
      expect(validateModule(ownIr)).toEqual([]);

      const emit = async (
        mod: IrModule,
        name: string,
        request = llvmEmitterRequest(),
      ): Promise<string> => {
        writeFileSync(input, serializeModule(mod));
        writeFileSync(config, JSON.stringify(request));
        const result = await execFileAsync(stage, [input, output, config], {
          ...runOptions,
          timeout: 300_000,
        }).catch((cause: unknown) => {
          throw new Error(`native LLVM emission failed for ${name}`, { cause });
        });
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toBe("");
        const text = readFileSync(output, "utf8");
        const expected = emitLlvmModule(mod, llvmEmitterOptions(request));
        expect(normalizedEmbeddingLlvm(text, mod), name).toBe(
          normalizedEmbeddingLlvm(expected, mod),
        );
        return text;
      };

      for (const item of llvmEmitterCases()) {
        expect(validateModule(item.module), item.name).toEqual([]);
        const text = await emit(item.module, item.name, item.request);
        for (const fragment of item.contains) expect(text, item.name).toContain(fragment);
        for (const fragment of item.excludes) expect(text, item.name).not.toContain(fragment);
      }

      // A refusal must leave the requested output untouched, with the same
      // exception category/message under Node and the compiled emitter.
      const rejected = llvmEmitterCases()[0]!.module;
      rejected.classes = [
        {
          name: "UnimplementedNative",
          fields: [],
          runtime: true,
          loc: { file: rejected.sourceFile, start: 0, end: 0 },
        },
      ];
      writeFileSync(input, serializeModule(rejected));
      writeFileSync(config, JSON.stringify(llvmEmitterRequest()));
      writeFileSync(output, "untouched");
      const args = [input, output, config];
      const oracleRefusal = spawnSync(
        process.execPath,
        ["--import", "tsx", entry, ...args],
        runOptions,
      );
      const nativeRefusal = spawnSync(stage, args, runOptions);
      for (const result of [oracleRefusal, nativeRefusal]) {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(2);
        expect(result.stderr.toString()).toBe("");
      }
      expect(nativeRefusal.stdout).toEqual(oracleRefusal.stdout);
      expect(nativeRefusal.stdout.toString()).toContain("classDef:UnimplementedNative");
      expect(readFileSync(output, "utf8")).toBe("untouched");

      for (const source of programs) {
        const sourcePath = join(root, "tests/corpus", source);
        const irPath = join(dir, "program.ir.json");
        const lowered = await compile(sourcePath, {
          outDir: dir,
          outPath: irPath,
          outputKind: "ir",
          dynamic: false,
        });
        if (!lowered.ok)
          throw new Error(`${source}: ${lowered.diagnostics.map((d) => d.message).join("\n")}`);
        const mod = deserializeModule(readFileSync(irPath, "utf8"));
        const request: LlvmEmitterRequest = llvmEmitterRequest({
          debug: true,
          sources: [{ file: sourcePath, text: readFileSync(sourcePath, "utf8") }],
        });
        const text = await emit(mod, source, request);
        const llvmPath = join(dir, "program.ll");
        const outPath = executable("program");
        writeFileSync(llvmPath, text);
        await compileC({
          cPath: llvmPath,
          outPath,
          sanitize,
          optimization: "dev",
          ...nativeFeatures(mod),
        });
        const node = spawnSync(process.execPath, [sourcePath], runOptions);
        const native = spawnSync(outPath, [], runOptions);
        for (const result of [node, native]) {
          expect(result.error, source).toBeUndefined();
          expect(result.signal, `${source}: ${result.stderr}`).toBeNull();
          expect(result.status, `${source}: ${result.stderr}`).toBe(0);
        }
        expect(native.stdout, source).toEqual(node.stdout);
        expect(programStderr(native.stderr), source).toBe(programStderr(node.stderr));
      }

      // The seed emits its own complete IR, including the production
      // optimizer and LLVM expression/library graph. Compile those bytes
      // and require a second native generation to reproduce the module.
      const self = await emit(ownIr, "LLVM emitter emits itself");
      const selfPath = join(dir, "self.ll");
      const secondStage = executable("emitter-second");
      writeFileSync(selfPath, self);
      await compileC({
        cPath: selfPath,
        outPath: secondStage,
        sanitize,
        optimization: "dev",
        ...nativeFeatures(ownIr),
      });
      const again = join(dir, "again.ll");
      const second = await execFileAsync(secondStage, [input, again, config], {
        ...runOptions,
        timeout: 300_000,
      });
      expect(second.stdout).toBe("");
      expect(second.stderr).toBe("");
      expect(readFileSync(again, "utf8")).toBe(self);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 1_200_000);
}
