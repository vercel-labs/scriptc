/* wasm32-wasi is a production LLVM target. This lane compares
 * pointer-width-sensitive corpus seeds against Node and pins the backend
 * selection independently of the host platform.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile, compileLibrary } from "@scriptc/compiler";
import { emitNativeArtifact } from "../../packages/compiler/src/backend/native-codegen.js";
import { WASM32_WASI_TARGET } from "../../packages/compiler/src/backend/targets.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function wasmCustomSectionNames(bytes: Uint8Array): string[] {
  let offset = 8;
  const names: string[] = [];
  const readUleb = (end: number): number => {
    let value = 0;
    let shift = 0;
    for (let count = 0; count < 5; count++) {
      if (offset >= end) throw new Error("truncated wasm LEB128 value");
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    throw new Error("oversized wasm LEB128 value");
  };
  while (offset < bytes.length) {
    const sectionId = bytes[offset++]!;
    const sectionSize = readUleb(bytes.length);
    const sectionEnd = offset + sectionSize;
    if (sectionEnd > bytes.length) throw new Error("truncated wasm section");
    if (sectionId === 0) {
      const nameLength = readUleb(sectionEnd);
      const nameEnd = offset + nameLength;
      if (nameEnd > sectionEnd) throw new Error("truncated wasm custom-section name");
      names.push(Buffer.from(bytes.subarray(offset, nameEnd)).toString("utf8"));
    }
    offset = sectionEnd;
  }
  return names;
}

const WASI_RUNNER = [
  'const fs=require("node:fs")',
  'const {WASI}=require("node:wasi")',
  "const p=process.argv[1]",
  'const wasi=new WASI({version:"preview1",args:[p],env:{...process.env,PWD:"/",HOME:"/",TMPDIR:"/tmp"},preopens:{"/":process.cwd(),"/tmp":"/tmp"},returnOnExit:true})',
  "const mod=new WebAssembly.Module(fs.readFileSync(p))",
  "const instance=new WebAssembly.Instance(mod,wasi.getImportObject())",
  "process.exitCode=wasi.start(instance)",
].join(";");

async function run(
  cmd: string,
  args: string[],
  input = "",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, exitCode: 0 });
      } else if (typeof error.code === "number") {
        resolve({ stdout, stderr, exitCode: error.code });
      } else {
        reject(error);
      }
    });
    // A closed pipe is the corpus harness's standard stdin. Closing it
    // explicitly also lets stdin/readline cases observe EOF under WASI.
    child.stdin?.end(input);
  });
}

function expectedExitCode(entry: string): number {
  const source = require("node:fs").readFileSync(entry, "utf8") as string;
  const match = /^\/\/ @exit:\s*(\d+)\s*$/m.exec(source);
  return match === null ? 0 : Number(match[1]);
}

describe.skipIf(!zigOnPath())("wasm32-wasi differential", () => {
  let oldCc: string | undefined;
  let oldTarget: string | undefined;

  beforeAll(() => {
    oldCc = process.env["SCRIPTC_CC"];
    oldTarget = process.env["SCRIPTC_TARGET"];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = "wasm32-wasi";
  });

  afterAll(() => {
    if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = oldCc;
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
  });

  test.each([
    "js-prototype-host-boundary.js",
    "js-regex-record-captures.js",
    "js-callable-proxy.js",
    "js-implicit-call-results.js",
    "js-inherited-field-storage.js",
    "js-normalize-dispatch.js",
    "js-super-accessor-initialization.js",
    "js-inferred-object-values.js",
    "js-static-accessors.js",
    "js-class-enumeration.js",
    "js-class-symbol-spread.cjs",
    "js-class-member-dispatch.js",
    "js-class-return-shapes.js",
    "js-optional-member-call.js",
    "js-promise-finally-order.js",
    "js-cjs-callable-snapshots/main.cjs",
    "js-inferred-callback-exports/main.js",
    "js-array-constructor.js",
    "array-numeric-own-keys.ts",
    "synchronous-callback-lifetimes.ts",
    "error-inherited-message.mjs",
    "js-class-shadowed-methods.js",
    "js-default-listener-arguments.cjs",
    "js-reflect-receivers.js",
    "js-loose-dynamic-primitives.js",
    "js-promise-pending-reactions.js",
    "js-promise-all-values.js",
    "js-promise-catch-handler.js",
    "js-abort-portable.js",
    "5240-event-target-subclass.ts",
    "5241-event-subclass.ts",
    "5242-event-target-subclass-hierarchy.ts",
    "5243-event-target-subclass-dynamic.ts",
    "5244-event-target-subclass.js",
    "5245-event-target-subclass-signals.ts",
    "5246-event-target-subclass-listener-throw.ts",
    "5247-event-target-subclass-lifetimes.ts",
    "5248-event-target-subclass-warnings.ts",
    "5249-event-target-subclass-unconstructed.ts",
    "5130-event-target-dispatch.js",
    "5131-event-target-listener-errors.js",
    "5132-event-target-typed.ts",
    "5133-abort-signal-event-target.ts",
    "5134-events-error-monitor.ts",
    "5135-event-target-warnings.js",
    "5136-events-error-monitor-string-name.ts",
    "5137-events-error-monitor-computed-name.js",
    "5138-events-error-monitor-shared-listener.ts",
    "5139-event-target-listener-throw.ts",
    // The digest set beyond SHA-1/SHA-2, its names, HMAC and the KDFs.
    "5435-crypto-hash-algorithms.ts",
    "5436-crypto-hash-names.js",
    "5437-crypto-hmac-algorithms.ts",
    "5438-crypto-kdf-digests.ts",
    "5439-crypto-kdf-callbacks.js",
    "5440-crypto-hash-encodings.js",
    "5441-crypto-hash-output-length.ts",
    "5442-crypto-random-values.ts",
    "5443-crypto-random-arguments.js",
    "5444-crypto-timing-safe-equal.js",
    "5445-crypto-secret-key-objects.ts",
    "5446-crypto-secret-key-errors.js",
    // Record literal operands and passing assertions in loops.
    "5520-assert-record-literal-failures.ts",
    // Empty custom messages.
    "5521-assert-empty-message.js",
    // throws and rejects failure properties.
    "5522-assert-throws-failure-properties.ts",
    // The Assert class.
    "5523-assert-class-options.js",
    "5524-assert-class-skip-prototype.ts",
    // AssertionError properties, the class, and its options.
    "5510-assert-error-properties.js",
    "5511-assert-error-class.ts",
    "5512-assert-error-options.js",
    // Loose deep equality and the typed deep messages.
    "5513-assert-deep-equal-loose.js",
    "5514-assert-deep-equal-typed.ts",
    "5515-assert-deep-strict-typed-messages.ts",
    "5516-assert-deep-equal-edges.js",
    // partialDeepStrictEqual.
    "5517-assert-partial-deep-equal.js",
    "5518-assert-partial-deep-typed.ts",
    "5519-assert-partial-deep-typed-edges.ts",
    "4031-event-emitter-long-tuples.ts",
    "2700-wasi-core.ts",
    "local-union-storage.ts",
    "class-callback-storage.ts",
    "array-sort-runs.ts",
    "array-primitive-ordering.ts",
    "uint8array-sort-domains.ts",
    "buffer-codec-boundaries.ts",
    "text-encode-into-boundaries.ts",
    "object-key-indexes.js",
    "record-key-order.ts",
    "typed-array-bulk-conversion.mjs",
    "typed-array-numeric-import.ts",
    "1612-cjs-module-globals.cjs",
    "992-fs-roundtrip.ts",
    "751-cycle-records-mutual.ts",
    "1000-json-stringify-basics.ts",
    "1002-json-parse-cast.ts",
    "1010-json-stringify-space.ts",
    "json-output-bulk.ts",
    "string-split-traversal.ts",
    "1565-union-element-join.ts",
    "5230-inline-union-fields.ts",
    "5232-inline-union-fields-dynamic.ts",
    "5234-inline-union-class-fields.ts",
    "5237-inline-union-frame-objects.ts",
    "5327-record-boundary-identity.ts",
    "5331-record-boundary-methods.ts",
    // Fetch named in text only, and pending top-level await exit statuses.
    "5334-fetch-mentions-without-calls.ts",
    "5335-top-level-await-pending-exit-code.ts",
    "5336-top-level-await-pending-exit-listener.ts",
    "1020-async-basics.ts",
    "1021-async-ordering.ts",
    "1022-async-exceptions.ts",
    "1023-async-rc-stress.ts",
    "1024-async-pending-exit.ts",
    "1025-async-promise-capture.ts",
    "1026-throw-promise.ts",
    "1027-async-return-promise.ts",
    "1028-async-return-record-literals.ts",
    "1029-async-eager-chains.ts",
    "1428-settled-await-order.ts",
    "1429-promise-catch-finally.ts",
    "1430-promise-race.ts",
    "1438-promise-all.ts",
    "1440-interval-basics.ts",
    "1444-exit-listeners.ts",
    "1447-stdin-closed-events.ts",
    "1475-readline-closed-stdin.ts",
    "1400-typedarray-basics.ts",
    "1409-typedarray-integer-loops.ts",
    "1660-buffer-read-write-num.ts",
    "byte-number-pipeline.ts",
    "byte-record-windows.ts",
    "counted-loop-numbers.ts",
    "module-byte-loops.ts",
    "1551-dyn-receiver-methods.ts",
    "1558-any-joins-and-dyn-validation.ts",
    "1634-inspect-classes.ts",
    "1644-ee-basics.ts",
    "1666-dyn-fn-identity.ts",
    "1800-immediate-basics.ts",
    "1805-timer-callback-args.ts",
    "2010-generators-basics.ts",
    "2011-generators-forof.ts",
    "2012-generators-return-throw.ts",
    "2013-generators-sent-values.ts",
    "2014-generators-values.ts",
    "2015-generators-yieldstar.ts",
    "2016-generators-rc-stress.ts",
    "2017-generators-async.ts",
    "5040-promise-all-race-turns.ts",
    "5042-async-generator-return-promise.ts",
    "5043-async-generator-return-forms.ts",
    "5085-promise-allsettled-turns.ts",
    "5086-promise-any-turns.ts",
    "5089-promise-settled-records.ts",
    "5087-promise-allsettled-any-dyn.js",
    "5088-promise-combinator-thenables.js",
    "2018-generators-uncaught.ts",
    "5839-timers-promises-scheduler.ts",
    "2019-generators-loops.ts",
    "2093-timers-promises.ts",
    "5830-timers-promises-signal.ts",
    "5889-timers-scheduler-signal.ts",
    "2683-fs-rename-js.cjs",
    "2906-bigint-wasi-width.ts",
    "4900-bigint-division-cross-check.ts",
    "4904-bigint-large-products.ts",
    "4905-bigint-fixed-width-fusion.ts",
    "4906-bigint-small-value-trees.ts",
    "4907-bigint-random-trees.ts",
    // Map/Set iteration reads ScrMap through size_t-width fields.
    "5315-map-iterate-after-front-deletes.ts",
    "5317-map-iterate-while-mutating.ts",
    "5318-set-iterate-after-deletes.ts",
    "5319-map-iteration-values.ts",
    // Hashed number-key lookups probe ScrMap through size_t-width fields.
    "5710-map-number-keys-hashed.ts",
    // JSON writers read array slots as pointers.
    "5305-json-stringify-typed-arrays.ts",
    // Comparator sorts move 64-bit slots of 32-bit pointers.
    "5360-array-sort-comparator-calls.ts",
    "5363-array-sort-comparator-writes.ts",
    "5365-array-sort-dynamic-values.js",
    // Blob reads settle through the dyn promise path on 32-bit pointers.
    "5286-blob-readers.ts",
    "5289-blob-read-order.ts",
    // InternTable handles carry 32-bit pointers in f64 slots.
    "5720-intern-table-basics.ts",
    "5721-intern-table-values.ts",
    // Array key sizes are checked in 32-bit size_t arithmetic.
    "5726-intern-table-key-limits.ts",
    // ThreadSlots blocks and pages hold 32-bit pointers.
    "5727-thread-slots-basics.ts",
    "5729-thread-slots-values.ts",
    // Weak-collection hashes mix 32-bit pointers in 64 bits.
    "4591-weak-keys-union-records.ts",
    "7742-weak-collections-many-keys.ts",
    // zlib's portable build (CPU_NO_SIMD) compresses to Node's bytes.
    "8405-zlib-compressed-bytes.ts",
  ])("the LLVM target runs %s byte-identically to Node", async (fixture) => {
    const entry = join(repoRoot, "tests/corpus", fixture);
    const outDir = await mkdtemp("/tmp/scriptc-wasi-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");
    expect(result.llvmPath.endsWith(".ll")).toBe(true);
    expect([...(await readFile(outPath)).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(process.execPath, [
      "--no-warnings",
      "--experimental-wasi-unstable-preview1",
      "-e",
      WASI_RUNNER,
      outPath,
    ]);
    expect(wasm.stdout).toBe(node.stdout);
    expect(wasm.exitCode).toBe(expectedExitCode(entry));
    expect(node.exitCode).toBe(expectedExitCode(entry));
    if (wasm.exitCode === 0) expect(wasm.stderr).toBe(node.stderr);
  });

  test("the explicit LLVM pin emits compact release wasm", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-refusal-");
    const outPath = join(outDir, "llvm.wasm");
    const llvmResult = await compile(join(repoRoot, "tests/corpus/001-hello.ts"), {
      outDir,
      outPath,
      backend: "llvm",
    });
    expect(llvmResult.ok).toBe(true);
    if (llvmResult.ok) {
      expect(llvmResult.backend).toBe("llvm");
      const wasm = await readFile(outPath);
      expect(wasmCustomSectionNames(wasm).filter((name) => name.startsWith(".debug"))).toEqual([]);
      expect(wasm.byteLength).toBeLessThan(256 * 1024);
    }
  });

  test("partitioned wasm32 objects link to the same program as one object", async () => {
    const dir = await mkdtemp("/tmp/scriptc-wasi-partitions-");
    // Internal callees, internal state, indirect calls through a table of
    // internal functions and a thread_local global, reached across partitions.
    const adds = [0, 1, 2, 3, 4, 5];
    const llvm = `@total = internal global i32 0
@zero = internal global i32 0
@counter = internal thread_local global i32 0
@handlers = internal constant [3 x ptr] [ptr @add0, ptr @add1, ptr @add2]
${adds
  .map(
    (index) => `define internal void @add${index}(i32 %value) noinline {
  %old = load i32, ptr @total
  %scaled = mul i32 %value, ${index + 1}
  %new = add i32 %old, %scaled
  store i32 %new, ptr @total
  ret void
}`,
  )
  .join("\n")}
define internal i32 @bump() noinline {
  %old = load i32, ptr @counter
  %new = add i32 %old, 1
  store i32 %new, ptr @counter
  ret i32 %new
}
define i32 @__main_argc_argv(i32 %argc, ptr %argv) {
${adds.map((index) => `  call void @add${index}(i32 ${index + 2})`).join("\n")}
  %base = load volatile i32, ptr @zero
${[0, 1, 2]
  .map(
    (slot) => `  %i${slot} = add i32 %base, ${slot}
  %p${slot} = getelementptr [3 x ptr], ptr @handlers, i32 0, i32 %i${slot}
  %f${slot} = load ptr, ptr %p${slot}
  call void %f${slot}(i32 3)`,
  )
  .join("\n")}
  %b0 = call i32 @bump()
  %b1 = call i32 @bump()
  %sum = load i32, ptr @total
  %code = add i32 %sum, %b1
  ret i32 %code
}
`;
    const emit = async (output: string, partitions: number, optimization: "0" | "2") => {
      const artifact = await emitNativeArtifact({
        outputPath: output,
        llvm,
        outputKind: "obj",
        sourcePath: "/src/partitions.ts",
        optimization,
        target: WASM32_WASI_TARGET,
        cacheRoot: null,
        partitions,
      });
      return artifact.outputPaths;
    };
    const link = async (objects: string[], name: string) => {
      const output = join(dir, name);
      await execFileAsync("zig", ["cc", "-target", "wasm32-wasi", ...objects, "-o", output]);
      return run(process.execPath, [
        "--no-warnings",
        "--experimental-wasi-unstable-preview1",
        "-e",
        WASI_RUNNER,
        output,
      ]);
    };
    // Release partitions import small functions from each other; dev
    // partitions compile independently.
    for (const optimization of ["2", "0"] as const) {
      const partitions = await emit(join(dir, `program-${optimization}.o`), 3, optimization);
      expect(partitions).toHaveLength(3);
      const again = await emit(join(dir, `again-${optimization}.o`), 3, optimization);
      expect(await Promise.all(again.map((path) => readFile(path)))).toEqual(
        await Promise.all(partitions.map((path) => readFile(path))),
      );
      const whole = await emit(join(dir, `whole-${optimization}.o`), 1, optimization);
      const partitioned = await link(partitions, `partitioned-${optimization}.wasm`);
      expect(partitioned).toEqual(await link(whole, `whole-${optimization}.wasm`));
      // 112 from the direct calls, 18 through the table, 2 from the counter.
      expect(partitioned.exitCode).toBe(132);
    }
  });

  test("sanitized library mode reports a target diagnostic before invoking the WASI toolchain", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-library-");
    const result = await compileLibrary({
      profilePath: join(repoRoot, "tests/library-mode/scalars/profile.json"),
      outDir,
      sanitize: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(/does not support sanitized library builds/);
    }
  });

  test("a global fetch call reports SC3002", async () => {
    const entry = join(repoRoot, "tests/fixtures/fetch/static-network-error/main.mts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-fetch-");
    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, "program.wasm"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(/network-backed fetch/);
    }
  });

  test.each([
    ["1360-spawn-sync.ts", /child processes/],
    ["1443-signal-handlers.ts", /OS signals/],
    ["1564-fs-watch.ts", /filesystem watching/],
    ["1780-http-res-surface.ts", /network sockets/],
  ])("reports unavailable WASI capabilities for %s", async (fixture, message) => {
    const outDir = await mkdtemp("/tmp/scriptc-wasi-capability-");
    const result = await compile(join(repoRoot, "tests/corpus", fixture), {
      outDir,
      outPath: join(outDir, "program.wasm"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(message);
    }
  });

  test("native promises cross checked-value boundaries", async () => {
    const entry = join(repoRoot, "tests/corpus/2633-island-promise-crossing.js");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-dynamic-promise-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, [entry]);
    const wasm = await run(process.execPath, [
      "--no-warnings",
      "--experimental-wasi-unstable-preview1",
      "-e",
      WASI_RUNNER,
      outPath,
    ]);
    expect(wasm).toEqual(node);
  });

  test.each(["cjs-named", "esm-entries"])(
    "the LLVM target compiles the %s npm packages natively",
    async (fixture) => {
      const entry = join(repoRoot, "tests/fixtures/npm/cases", fixture, "main.ts");
      const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-");
      const outPath = join(outDir, "program.wasm");
      const result = await compile(entry, { outDir, outPath });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.backend).toBe("llvm");

      const node = await run(process.execPath, ["--no-warnings", entry]);
      const wasm = await run(process.execPath, [
        "--no-warnings",
        "--experimental-wasi-unstable-preview1",
        "-e",
        WASI_RUNNER,
        outPath,
      ]);
      expect(wasm).toEqual(node);
    },
  );

  test.each(["top-level-await-pending-exit-code", "top-level-await-pending-exit-listener"])(
    "npm packages keep the pending-module exit precedence for %s",
    async (fixture) => {
      const entry = join(repoRoot, "tests/fixtures/npm/cases", fixture, "main.ts");
      const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-pending-");
      const outPath = join(outDir, "program.wasm");
      const result = await compile(entry, { outDir, outPath });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.backend).toBe("llvm");

      const node = await run(process.execPath, ["--no-warnings", entry]);
      const wasm = await run(process.execPath, [
        "--no-warnings",
        "--experimental-wasi-unstable-preview1",
        "-e",
        WASI_RUNNER,
        outPath,
      ]);
      expect(wasm).toEqual(node);
    },
  );

  test("the LLVM target embeds compressed npm sources and builtin shims", async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/zlib-shims/main.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-npm-zlib-");
    const outPath = join(outDir, "program.wasm");
    const result = await compile(entry, { outDir, outPath });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.backend).toBe("llvm");

    const node = await run(process.execPath, ["--no-warnings", entry]);
    const wasm = await run(process.execPath, [
      "--no-warnings",
      "--experimental-wasi-unstable-preview1",
      "-e",
      WASI_RUNNER,
      outPath,
    ]);
    expect(wasm).toEqual(node);
  });

  test("scriptc run hosts the module with inherited stdio", async () => {
    const entry = join(repoRoot, "tests/corpus/2700-wasi-core.ts");
    const outDir = await mkdtemp("/tmp/scriptc-wasi-cli-");
    const loader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
    const result = await execFileAsync(process.execPath, [
      "--import",
      loader,
      join(repoRoot, "packages/cli/src/main.ts"),
      "run",
      entry,
      "--no-keep-llvm",
      "-o",
      join(outDir, "program.wasm"),
    ]);
    const node = await execFileAsync(process.execPath, [entry]);
    expect(result.stdout).toBe(node.stdout);
    expect(result.stderr).toBe(node.stderr);
  });
});
