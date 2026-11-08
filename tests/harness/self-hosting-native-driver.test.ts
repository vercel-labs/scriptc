import { seedBuildEnvironment, verifyBootstrapSeed } from "../../scripts/bootstrap-seed.mjs";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { WASI } from "node:wasi";
import { expect, test } from "vitest";
import type { NativeToolchainManifest } from "../../packages/compiler/src/native/toolchain.js";
import { RUNTIME_ABI_MARKER } from "../../packages/compiler/src/backend/runtime-abi.js";
import {
  nativeBootstrapPlan,
  runNativeBootstrapChecks,
} from "../../scripts/ci-native-bootstrap.mjs";
import { withoutFirstLine } from "./large-artifacts.js";
import { checkBuildCacheContracts } from "./native-build-cache-contracts.js";
import { bootstrapStep } from "./self-hosting-timing.js";
import { unbundlePlatformPackages } from "../../scripts/native-cli-bundle.mjs";

const root = join(import.meta.dirname, "../..");
const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const phase = process.env["SCRIPTC_BOOTSTRAP_PHASE"] ?? "all";
const plan = nativeBootstrapPlan({ phase, sanitize });

function comparableStderr(text: string): string {
  return sanitize
    ? text.replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      )
    : text;
}

function absoluteCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory, command + extension);
      if (existsSync(path)) return resolve(path);
    }
  }
  throw new Error(`native tool is not on PATH: ${command}`);
}

// The seed build is the compiler compiling itself, so it grows with main: on
// 32-vCPU Sandboxes its fastest plain build went from 471 s (base of
// 2026-10-27) to 712 s (2026-11-07), about 145 s a week, and the same tree
// takes up to 1.66 times as long on one machine as on another. Of 244 plain
// builds on 2026-11-07 the median took 1009 s and the slowest tenth 1447 s
// or more, and eight were stopped at the 1800 s every step is allowed. Its
// own limit is twice that, which the fastest build reaches after about ten
// more weeks of the same growth on the slowest machine; the limit is the
// place to look when it does. CI builds the seed in a job of its own
// (bootstrap_seed) and never runs this step.
const seedBuildTimeoutMs = sanitize ? 5_400_000 : 3_600_000;

test(
  `the production CLI passes ${phase} bootstrap contracts with Node unavailable`,
  async () => {
    const sharedSeed = process.env["SCRIPTC_BOOTSTRAP_SEED_DIRECTORY"];
    const directory =
      sharedSeed ??
      mkdtempSync(
        join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-bootstrap-"),
      );
    if (sharedSeed) verifyBootstrapSeed(sharedSeed, process.env["GITHUB_SHA"], sanitize);
    const executable = (name: string) =>
      join(directory, name + (process.platform === "win32" ? ".exe" : ""));
    const options = {
      cwd: root,
      timeout: sanitize ? 5_400_000 : 1_800_000,
      maxBuffer: 16 * 1024 * 1024,
    };
    try {
      const distribution = join(directory, "distribution");
      if (!sharedSeed)
        await bootstrapStep("build production CLI seed", () =>
          exec(
            process.execPath,
            [
              "--max-old-space-size=8192",
              "--import",
              "tsx",
              join(root, "scripts/build-native-cli.mts"),
              distribution,
            ],
            {
              // The plain lane retains release optimization. Instrumenting a dev
              // seed avoids optimizing the huge compiler module before ASan can
              // exercise its complete traversal, serialization and LLVM emission.
              ...options,
              timeout: seedBuildTimeoutMs,
              env: { ...process.env, ...seedBuildEnvironment(sanitize) },
            },
          ),
        );
      // CI reuses this already-built seed for npm and older-libc installation
      // smoke tests, avoiding another full compiler build on the critical path.
      const packageDirectory = process.env["SCRIPTC_BOOTSTRAP_PACKAGE_DIR"];
      if (plan.packageChecks && packageDirectory !== undefined) {
        if (process.platform !== "linux" || process.arch !== "x64")
          throw new Error("bootstrap package export requires the Linux x64 GNU CI host");
        mkdirSync(packageDirectory, { recursive: true });
        cpSync(
          join(root, "packages/cli-linux-x64-gnu/package.json"),
          join(packageDirectory, "package.json"),
        );
        cpSync(distribution, join(packageDirectory, "dist"), { recursive: true });
        // The npm package depends on its LLVM helper and runtime pack. Link
        // them into its node_modules, as pnpm links a workspace package's
        // dependencies, so the package checks resolve them.
        unbundlePlatformPackages(
          join(packageDirectory, "dist"),
          join(packageDirectory, "dist/bin/scriptc.json"),
          "@scriptc/llvm-linux-x64-gnu",
        );
        mkdirSync(join(packageDirectory, "node_modules/@scriptc"), { recursive: true });
        for (const name of ["llvm-linux-x64-gnu", "runtime-linux-x64-gnu"])
          symlinkSync(
            join(root, "packages", name),
            join(packageDirectory, "node_modules/@scriptc", name),
            "dir",
          );
        writeFileSync(packageDirectory + ".ready", "ready\n");
      }
      // All compiler assets must survive moving the complete distribution.
      const relocated = join(directory, "relocated");
      renameSync(distribution, relocated);
      const seed = join(relocated, "bin", "scriptc" + (process.platform === "win32" ? ".exe" : ""));
      const manifestPath = seed + ".json";
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NativeToolchainManifest;
      manifest.linker = absoluteCommand(manifest.linker);
      if (process.platform === "linux") {
        // Clang delegates linking to a separate executable. Resolve it before
        // removing PATH so the complete native toolchain remains available.
        const linker = await exec(
          manifest.linker,
          [...manifest.linker_args, "--print-prog-name=ld"],
          options,
        );
        manifest.linker_args.push("--ld-path=" + absoluteCommand(linker.stdout.trim()));
      }
      if (process.platform === "darwin") manifest.dsymutil = absoluteCommand(manifest.dsymutil);
      if (process.platform === "darwin") manifest.relocatable_linker = absoluteCommand("ld");
      manifest.archiver = absoluteCommand(process.platform === "win32" ? "zig" : "ar");
      manifest.archiver_args = process.platform === "win32" ? ["ar"] : [];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      let sanitizerCompiler: string | undefined;
      if (sanitize) {
        sanitizerCompiler = absoluteCommand(process.env["SCRIPTC_CC"] ?? "clang");
        if (process.platform === "linux") {
          const linker = await exec(sanitizerCompiler, ["--print-prog-name=ld"], options);
          const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
          const wrapper = join(directory, "sanitizer-clang");
          // Preserve the empty PATH while making Clang's child linker explicit.
          writeFileSync(
            wrapper,
            `#!/bin/sh\nexec ${quote(sanitizerCompiler)} ${quote("--ld-path=" + absoluteCommand(linker.stdout.trim()))} "$@"\n`,
          );
          chmodSync(wrapper, 0o755);
          sanitizerCompiler = wrapper;
        }
      }
      const nativeOptions = {
        ...options,
        env: {
          ...process.env,
          PATH: "",
          SCRIPTC_TOOLCHAIN: manifestPath,
          SCRIPTC_CACHE_DIR: join(directory, "cache"),
          ...(sanitizerCompiler === undefined ? {} : { SCRIPTC_CC: sanitizerCompiler }),
        },
      };
      const invoke = async (
        compiler: string,
        args: string[],
        expectedStderr = "",
        env: Record<string, string> = {},
      ) => {
        // An ASan-instrumented compiler's frames are several times larger, and
        // its recursion over the compiler's own deep ASTs overflows the
        // default 8 MiB stack (SC3004). Raise the soft limit to the hard limit
        // for each sanitized compiler process, as a shell's ulimit would.
        const [file, argv] =
          sanitize && process.platform !== "win32"
            ? [
                "/bin/sh",
                ["-c", 'ulimit -s "$(ulimit -H -s)" && exec "$0" "$@"', compiler, ...args],
              ]
            : [compiler, args];
        const result = await exec(file, argv, {
          ...nativeOptions,
          env: { ...nativeOptions.env, ...env },
        }).catch((error: unknown) => {
          const failure = error as Error & {
            code?: string | number;
            signal?: string;
            stdout?: string;
            stderr?: string;
          };
          throw new Error(
            `${failure.message}\ncode=${failure.code} signal=${failure.signal}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`,
            { cause: error },
          );
        });
        expect(comparableStderr(result.stderr)).toBe(expectedStderr);
        return result.stdout;
      };
      const entry = join(root, "packages/compiler/src/native/cli.ts");
      // The compiler's own source has untyped functions that SC6101 reports
      // (diagnostics/dynamic-tier.ts). The contracts compare stderr exactly,
      // so its self-builds leave that performance note out.
      const quiet = "--no-dynamic-tier-warning";
      // It also converts values between layouts at several thousand places
      // SC6001 reports (frontend/lowering/width-copies.ts): its IR nodes
      // are records of many shapes. The self-builds leave that out too.
      const copies = "--no-copy-warning";
      const ffi = join(directory, ".scriptc/distribution-seed/compiler.ffi.json");
      const rebuilt = executable("scriptc-rebuilt");
      const checkProgram = async (compiler: string, source: string, extra: string[] = []) => {
        // This basename formerly collided with the driver's temporary object.
        const probeDirectory = join(
          directory,
          compiler === seed ? "seed-probes" : "rebuilt-probes",
        );
        mkdirSync(probeDirectory, { recursive: true });
        const output = join(
          probeDirectory,
          "program.o" + (process.platform === "win32" ? ".exe" : ""),
        );
        const built = await invoke(compiler, [
          "build",
          source,
          "-o",
          output,
          "--optimization=dev",
          "--strip",
          ...extra,
        ]);
        expect(built.trim()).toBe(output);
        const oracle = spawnSync(process.execPath, [source], options);
        const actual = spawnSync(output, [], nativeOptions);
        for (const result of [oracle, actual]) {
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr.toString()).toBe(0);
        }
        expect(actual.stdout).toEqual(oracle.stdout);
        expect(actual.stderr).toEqual(oracle.stderr);
      };
      const sample = join(root, "tests/corpus/class-array-optional-return.ts");
      const unionSample = join(root, "tests/corpus/union-nested-layout-discriminant.ts");
      const receiverSample = join(root, "tests/corpus/llvm-read-receiver-lifetime.ts");
      // CI assigns command probes and self-rebuilds to separate runners. A
      // direct invocation retains both phases and drains them before cleanup.
      const seedChecks = async () => {
        // All command, library, and dynamic probes run inside the instrumented
        // compiler in the sanitizer lane, including their failure paths.
        const probe = seed;
        expect(await invoke(probe, ["--help"])).toContain("scriptc build");
        expect((await invoke(probe, ["--version"])).trim()).toBe(manifest.compiler_version);
        const linked = join(directory, "package link");
        symlinkSync(relocated, linked, process.platform === "win32" ? "junction" : "dir");
        const linkedSeed = join(
          linked,
          "bin",
          "scriptc" + (process.platform === "win32" ? ".exe" : ""),
        );
        const hello = join(root, "tests/corpus/001-hello.ts");
        const oracle = await exec(process.execPath, [hello], options);
        const throughLink = await exec(
          linkedSeed,
          ["run", hello, "-o", executable("linked-hello"), "--optimization=dev", "--strip"],
          {
            ...nativeOptions,
            env: { ...nativeOptions.env, SCRIPTC_TOOLCHAIN: undefined },
          },
        );
        expect(throughLink.stdout).toBe(oracle.stdout);
        expect(comparableStderr(throughLink.stderr)).toBe(oracle.stderr);
        await checkProgram(probe, sample);
        await checkProgram(probe, unionSample);
        await checkProgram(probe, receiverSample);
        await checkProgram(probe, join(root, "tests/corpus/closure-nullable-union-return.ts"));
        await checkProgram(probe, join(root, "tests/corpus/record-optional-json-presence.ts"));
        await checkProgram(probe, join(root, "tests/corpus/1010-json-stringify-space.ts"));
        await checkProgram(probe, join(root, "tests/corpus/fs-write-string-bytes-union.ts"));
        // Exact import-cycle initialization and weak keys from unions and empty objects.
        await checkProgram(probe, join(root, "tests/corpus/4592-cycle-const-from-import/main.ts"));
        await checkProgram(probe, join(root, "tests/corpus/4591-weak-keys-union-records.ts"));
        await checkProgram(probe, join(root, "tests/corpus/4593-weak-keys-empty-objects.ts"));

        // A build from a lowered program (executable/lowered.ts) writes the
        // executable a build from the sources writes, and refuses the file
        // once a source changed.
        const loweredSource = join(directory, "lowered-probe.ts");
        writeFileSync(
          loweredSource,
          'const parts: string[] = ["lowered", "program"];\nconsole.log(parts.join(" "));\n',
        );
        const loweredFile = join(directory, "lowered-probe.lowered");
        const loweredOutput = executable("lowered-probe");
        const loweredArgs = [
          "build",
          loweredSource,
          "-o",
          loweredOutput,
          "--optimization=dev",
          "--strip",
        ];
        await invoke(probe, [...loweredArgs, "--emit-lowered", loweredFile]);
        const fromSources = readFileSync(loweredOutput);
        const loweredLlvm = readFileSync(join(directory, "lowered-probe.ll"));
        await invoke(probe, [...loweredArgs, "--from-lowered", loweredFile]);
        expect(readFileSync(join(directory, "lowered-probe.ll")).equals(loweredLlvm)).toBe(true);
        expect(readFileSync(loweredOutput).equals(fromSources)).toBe(true);
        expect(spawnSync(loweredOutput, [], nativeOptions).stdout.toString()).toBe(
          "lowered program\n",
        );
        writeFileSync(loweredSource, readFileSync(loweredSource, "utf8") + "// edited\n");
        const stale = spawnSync(
          probe,
          [...loweredArgs, "--from-lowered", loweredFile],
          nativeOptions,
        );
        expect(stale.status).toBe(1);
        expect(stale.stderr.toString()).toContain(
          `--from-lowered: ${loweredFile} does not match this build's inputs: ${loweredSource} changed since it was lowered`,
        );

        const fetchOptions = join(directory, "fetch-options.ts");
        writeFileSync(
          fetchOptions,
          'async function probe() { const response = await fetch("https://example.invalid", { headers: { accept: "application/json" } }); console.log(response.status); } if (process.env["RUN_NATIVE_FETCH_PROBE"] === "1") await probe();\n',
        );
        await checkProgram(probe, fetchOptions);
        expect(await invoke(probe, ["coverage", fetchOptions])).toContain("(100%)");

        const dynamic = join(directory, "dynamic.ts");
        writeFileSync(
          dynamic,
          "const value: any = { answer: 42 }; console.log(`answer:${value.answer}`);\n",
        );
        await checkProgram(probe, dynamic);
        const comptime = join(directory, "comptime.ts");
        writeFileSync(
          comptime,
          "const answer = comptime(() => [1, 2, 3].reduce((sum, value) => sum + value, 0) * 7); console.log(answer);\n",
        );
        expect(
          await invoke(probe, ["run", comptime, "-o", executable("comptime"), "--strip"]),
        ).toBe("42\n");
        // The evaluator this compiler starts is the Node host's: it holds no
        // host object and bakes the values Node computes.
        const isolated = join(directory, "comptime-isolated.ts");
        writeFileSync(
          isolated,
          `const reached = comptime(() => {
  const g: any = globalThis;
  return String(g.constructor.constructor("return typeof process === 'object' ? 'host process' : 'no host'")());
});
const table = comptime(() => [Math.sin(0.5), Math.cbrt(2), Math.hypot(1, 2, 3)]);
console.log(reached, table[0] === Math.sin(0.5), table[1] === Math.cbrt(2), table[2] === Math.hypot(1, 2, 3));
`,
        );
        expect(
          await invoke(probe, ["run", isolated, "-o", executable("comptime-isolated"), "--strip"]),
        ).toBe("no host true true true\n");
        for (const program of [
          "1050-comptime-tables.ts",
          "1051-comptime-strings.ts",
          "1052-comptime-records.ts",
          "1053-comptime-json.ts",
          "1054-comptime-modules/main.ts",
          "8961-comptime-node-values.ts",
          "8962-comptime-result-data.ts",
        ]) {
          const source = join(root, "tests/corpus", program);
          const oracle = spawnSync(
            process.execPath,
            ["--import", join(root, "tests/harness/comptime-shim.mjs"), source],
            options,
          );
          expect(oracle.status, oracle.stderr.toString()).toBe(0);
          expect(
            await invoke(probe, ["run", source, "-o", executable("comptime-corpus"), "--strip"]),
            program,
          ).toBe(oracle.stdout.toString());
        }

        // A rebuild answers as a cold build does, whatever was edited.
        await checkBuildCacheContracts({
          compiler: probe,
          directory: join(directory, "build-cache"),
          env: nativeOptions.env,
          run: (file, args, env) => exec(file, args, { ...nativeOptions, env }),
        });

        const object = join(directory, "program.obj");
        const linkInfo = JSON.parse(
          await invoke(probe, ["build", sample, "-o", object, "--print=native-link-info"]),
        );
        expect(linkInfo.program.object).toBe(object);
        expect(readFileSync(object).length).toBeGreaterThan(0);

        const profile = join(root, "tests/library-mode/contract-attest/profile.json");
        const archive = join(directory, "contract.a");
        const expectedArchive = join(directory, "contract-node.a");
        await exec(
          process.execPath,
          [
            join(root, "packages/cli/dist/main.js"),
            "build",
            "--lib",
            "--profile",
            profile,
            "-o",
            expectedArchive,
          ],
          options,
        );
        await invoke(probe, ["build", "--lib", "--profile", profile, "-o", archive]);
        expect(JSON.parse(readFileSync(archive + ".contract.json", "utf8"))).toEqual(
          JSON.parse(readFileSync(expectedArchive + ".contract.json", "utf8")),
        );

        // Integer-slot checking walks every library call's argument types,
        // including bytes and arrays, inside the native compiler itself.
        const intProfile = join(root, "tests/library-mode/contract-int-libcall/profile.json");
        const intArchive = join(directory, "contract-int.a");
        const expectedIntArchive = join(directory, "contract-int-node.a");
        await exec(
          process.execPath,
          [
            join(root, "packages/cli/dist/main.js"),
            "build",
            "--lib",
            "--profile",
            intProfile,
            "-o",
            expectedIntArchive,
          ],
          options,
        );
        await invoke(probe, ["build", "--lib", "--profile", intProfile, "-o", intArchive]);
        const intContract = JSON.parse(readFileSync(intArchive + ".contract.json", "utf8"));
        expect(intContract.integer_slots).toEqual([{ slot: "Model.phase", class: "i64" }]);
        expect(intContract).toEqual(
          JSON.parse(readFileSync(expectedIntArchive + ".contract.json", "utf8")),
        );

        // The unmodified package exercises deep validator traversals. Compile it
        // through the installed CLI, including its async command boundary.
        const threeProfile = join(root, "tests/library-mode/wasm/three.json");
        await invoke(probe, [
          "build",
          "--lib",
          "--profile",
          threeProfile,
          "-o",
          join(directory, "three.a"),
        ]);
        if (
          process.platform !== "win32" &&
          spawnSync("zig", ["version"]).status === 0 &&
          existsSync(join(root, "packages/runtime-wasm32-wasi/runtime-pack.json"))
        ) {
          const linker = join(directory, "zigcc");
          writeFileSync(
            linker,
            `#!/bin/sh\nexec '${absoluteCommand("zig").replaceAll("'", "'\\''")}' cc "$@"\n`,
            { mode: 0o755 },
          );
          const output = join(directory, "three.wasm");
          const missing = spawnSync(
            probe,
            ["build", "--lib", "--profile", threeProfile, "-o", output],
            {
              ...nativeOptions,
              cwd: directory,
              env: {
                ...nativeOptions.env,
                SCRIPTC_TARGET: "wasm32-wasi",
                SCRIPTC_LINKER: linker,
                SCRIPTC_RUNTIME_PACK: undefined,
                SCRIPTC_NO_CACHE: "1",
              },
            },
          );
          expect(missing.status).toBe(1);
          expect(missing.stderr.toString()).toContain(
            "error SC3003: runtime pack for wasm32-wasi is not installed; install @scriptc/runtime-wasm32-wasi@",
          );
          expect(missing.stderr.toString()).toContain(
            "hint: scriptc includes the runtime pack for its own platform only",
          );
          // Install the cross-target pack after relocating the native compiler.
          // Its resolver must discover project dependencies without Node on PATH.
          const scope = join(directory, "node_modules/@scriptc");
          mkdirSync(scope, { recursive: true });
          symlinkSync(
            join(root, "packages/runtime-wasm32-wasi"),
            join(scope, "runtime-wasm32-wasi"),
            "dir",
          );
          const built = await exec(
            probe,
            ["build", "--lib", "--profile", threeProfile, "-o", output],
            {
              ...nativeOptions,
              cwd: directory,
              env: {
                ...nativeOptions.env,
                SCRIPTC_TARGET: "wasm32-wasi",
                SCRIPTC_LINKER: linker,
                SCRIPTC_RUNTIME_PACK: undefined,
                SCRIPTC_NO_CACHE: "1",
              },
            },
          );
          expect(built.stdout.trim()).toBe(output);
          expect(comparableStderr(built.stderr)).toBe("");
          const vertices: number[][] = [];
          const surfaces: number[][] = [];
          const resources: number[][] = [];
          const wasi = new WASI({ version: "preview1" });
          const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(output)), {
            ...wasi.getImportObject(),
            scriptc: {
              vertex: (...args: number[]) =>
                vertices.push(args.map((value) => Number(value.toFixed(9)))),
              surface: (...args: number[]) =>
                surfaces.push(args.map((value) => Number(value.toFixed(9)))),
              resource: (...args: number[]) => resources.push(args),
              panic: () => {
                throw new Error("unexpected Wasm panic");
              },
            },
          });
          wasi.initialize(instance);
          const api = instance.exports as Record<string, (...args: number[]) => number>;
          api.app_init!();
          for (const time of [0, 123, 2000]) expect(api.app_frame!(time, 1.5)).toBe(24);
          api.app_dispose!();
          const oracle = await exec(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `
          const vertices = [], surfaces = [], resources = [];
          globalThis.vertex = (...args) => vertices.push(args.map(value => Number(value.toFixed(9))));
          globalThis.surface = (...args) => surfaces.push(args.map(value => Number(value.toFixed(9))));
          globalThis.resource = (...args) => resources.push(args);
          const { frame, dispose } = await import(${JSON.stringify(join(root, "tests/library-mode/wasm/three.mjs"))});
          for (const time of [0, 123, 2000]) frame(time, 1.5);
          dispose();
          console.log(JSON.stringify({ vertices, surfaces, resources }));
        `,
            ],
            options,
          );
          expect({ vertices, surfaces, resources }).toEqual(JSON.parse(oracle.stdout));
          expect(oracle.stderr).toBe("");
          api.app_collect!();
        }

        const badSource = join(directory, "bad.ts");
        writeFileSync(badSource, 'const value: number = "wrong"; console.log(value);\n');
        const retained = executable("retained");
        writeFileSync(retained, "existing output");
        const failed = spawnSync(probe, ["build", badSource, "-o", retained], nativeOptions);
        expect(failed.status).toBe(1);
        expect(failed.stderr.toString()).toContain("not assignable");
        expect(readFileSync(retained, "utf8")).toBe("existing output");

        // Which options a command takes is read from the command table
        // (cli/usage.ts): the native CLI refuses the same ones with the same line.
        for (const [args, refusal] of [
          [
            ["cache", "warm", "--strip"],
            "scriptc cache warm takes only native optimization/sanitizer options and profile names",
          ],
          [
            ["merge-profiles", "-o", join(directory, "merged.profdata"), "--tier=auto", "a"],
            "scriptc merge-profiles takes -o <out.profdata>, optionally --sparse, and one or more profiles",
          ],
          [
            ["build", "--lib", "--profile", profile, "--node-island=left-pad"],
            "scriptc build --lib takes no --backend/--emit/--print/",
          ],
          [["build", "--wasm=module.wasm", hello], "--wasm is a coverage-only option"],
        ] as const) {
          const refused = spawnSync(probe, args, nativeOptions);
          expect(refused.status, args.join(" ")).toBe(1);
          expect(
            comparableStderr(refused.stderr.toString()).split("\n")[0],
            args.join(" "),
          ).toContain(refusal);
        }
      };
      // The production chain owns the complete frontend and emitter proof:
      // compare the Node seed's IR and LLVM with the native self-rebuild, then
      // execute the next compiler generation. Large structural checks run in a
      // roomy child so Vitest's worker remains responsive.
      const seedDirectory = join(directory, ".scriptc/distribution-seed");
      const seedIr = join(seedDirectory, "cli.ir.json");
      const compareArtifacts = async ({ ir, llvm }: { ir: boolean; llvm: boolean }) => {
        const comparison = await bootstrapStep(
          `compare Node and native compiler ${[ir ? "IR" : "", llvm ? "LLVM" : ""].filter(Boolean).join(" and ")}`,
          () =>
            exec(
              process.execPath,
              [
                "--max-old-space-size=8192",
                "--import",
                "tsx",
                "--input-type=module",
                "--eval",
                `
            import assert from 'node:assert/strict';
            import { readFileSync } from 'node:fs';
            import { isDeepStrictEqual } from 'node:util';
            import { deserializeModuleBytes, validateModule } from ${JSON.stringify(pathToFileURL(join(root, "packages/compiler/src/index.ts")).href)};
            import { occurrences, withoutRange } from ${JSON.stringify(pathToFileURL(join(root, "tests/harness/large-artifacts.ts")).href)};
            // Both artifacts are compared as bytes and per-function documents:
            // either can exceed V8's maximum string length.
            if (${ir}) {
              const expected = deserializeModuleBytes(readFileSync(process.argv[1]));
              const actual = deserializeModuleBytes(readFileSync(process.argv[2]));
              assert.ok(actual.functions.length > 1000);
              assert.deepEqual(validateModule(actual), []);
              assert.ok(isDeepStrictEqual(actual, expected), 'native self-lowering must match the Node seed');
            }
            if (${llvm}) {
              const seedLlvm = readFileSync(process.argv[3]);
              let nativeLlvm = readFileSync(process.argv[4]);
              if (${sanitize}) {
                // The Node sanitizer builds runtime sources directly; the native
                // executable path also emits the runtime ABI check. Pin that
                // difference before comparing the rest of the complete module.
                const declaration = 'declare void @' + ${JSON.stringify(RUNTIME_ABI_MARKER)} + '()\\n';
                const call = '  call void @' + ${JSON.stringify(RUNTIME_ABI_MARKER)} + '()\\n';
                for (const line of [declaration, call]) {
                  assert.equal(occurrences(seedLlvm, line).length, 0);
                  const found = occurrences(nativeLlvm, line);
                  assert.equal(found.length, 1);
                  nativeLlvm = withoutRange(nativeLlvm, found[0], Buffer.byteLength(line));
                }
              }
              assert.ok(seedLlvm.equals(nativeLlvm), 'native LLVM emission must match the Node seed');
            }
          `,
                seedIr,
                join(directory, "cli.ir.json"),
                join(seedDirectory, "cli.ll"),
                join(directory, "cli.ll"),
              ],
              options,
            ),
        );
        expect(comparison.stdout).toBe("");
        expect(comparison.stderr).toBe("");
      };
      const probeRebuilt = async () => {
        await checkProgram(rebuilt, join(root, "tests/corpus/nullish-long-chain.ts"));
        await checkProgram(rebuilt, sample);
        await checkProgram(rebuilt, unionSample);
        await checkProgram(rebuilt, receiverSample);
        await checkProgram(rebuilt, join(root, "tests/corpus/1010-json-stringify-space.ts"));
      };
      const settle = async (checks: Promise<void>[]) => {
        for (const check of await Promise.allSettled(checks))
          if (check.status === "rejected") throw check.reason;
      };
      // --strip keeps debug metadata out of the IR/LLVM equality comparison.
      const rebuildChecks = async () => {
        // The plain lane optimizes the next generation for its fixed-point check.
        const self = await bootstrapStep("production CLI rebuilds itself", () =>
          invoke(
            seed,
            [
              "build",
              entry,
              "-o",
              rebuilt,
              "--strip",
              "--keep-llvm",
              "--emit-ir",
              "--ffi",
              ffi,
              quiet,
              copies,
            ],
            "scriptc: warning: --emit-ir is deprecated; use --emit=ir for IR as the primary output\n",
          ),
        );
        expect(self.trim()).toBe(rebuilt);
        const fixedPoint = async () => {
          // The plain lane owns the third-generation fixed point. The sanitizer
          // lane runs the complete frontend and emitter under ASan in its two
          // rebuild halves, compares both artifacts, and executes the new
          // compiler.
          const seedLlvm = join(directory, "cli.ll");
          const rebuiltLlvm = join(directory, "rebuilt.ll");
          // Every range's emit worker exits failing (SCRIPTC_EMIT_WORKER_FAIL),
          // so this generation runs the serial fallback for the whole module
          // and must still write the LLVM the seed wrote.
          await bootstrapStep("rebuilt compiler emits itself", () =>
            invoke(
              rebuilt,
              ["build", entry, "--emit=llvm", "-o", rebuiltLlvm, "--ffi", ffi, quiet, copies],
              "",
              { SCRIPTC_EMIT_WORKER_FAIL: "all" },
            ),
          );
          // Executable output adds a runtime ABI check; textual LLVM emission
          // omits it. Compare all other output without changing either mode.
          const withoutAbiCheck = (path: string): Buffer =>
            withoutFirstLine(
              withoutFirstLine(
                readFileSync(path),
                "declare void @scr_runtime_abi_v",
                /^declare void @scr_runtime_abi_v\d+\(\)\n$/,
              ),
              "  call void @scr_runtime_abi_v",
              /^  call void @scr_runtime_abi_v\d+\(\)\n$/,
            );
          expect(
            withoutAbiCheck(seedLlvm).equals(withoutAbiCheck(rebuiltLlvm)),
            "native compiler generations must emit identical LLVM",
          ).toBe(true);
        };
        await settle([compareArtifacts({ ir: true, llvm: true }), probeRebuilt(), fixedPoint()]);
      };
      // The sanitizer lane splits the instrumented self-rebuild at the IR
      // boundary. Its frontend half lowers the compiler inside the instrumented
      // seed and compares that IR with the seed's; lowering does not depend on
      // the output's sanitizer or optimization options. Its emitter half runs
      // the instrumented LLVM emitter on the seed's IR (equal to the native IR
      // by the frontend half's comparison), compares the LLVM, then links and
      // executes an instrumented development compiler.
      const rebuildFrontend = async () => {
        const lowered = join(directory, "cli.ir.json");
        const output = await bootstrapStep("sanitized native frontend lowers the compiler", () =>
          invoke(seed, ["build", entry, "--emit=ir", "-o", lowered, "--ffi", ffi, quiet, copies]),
        );
        expect(output.trim()).toBe(lowered);
        await compareArtifacts({ ir: true, llvm: false });
      };
      const rebuildEmit = async () => {
        const self = await bootstrapStep("sanitized native emitter rebuilds the compiler", () =>
          invoke(
            seed,
            [
              "build",
              entry,
              "-o",
              rebuilt,
              "--strip",
              "--keep-llvm",
              "--ffi",
              ffi,
              "--sanitize",
              "--optimization=dev",
              // The seed's IR, lowered by the JavaScript compiler with the
              // seed build's options: an IR artifact records none of what a
              // lowered program depends on, so each kind is accepted here,
              // and the two comparisons around this build stand in for them.
              "--from-lowered",
              seedIr,
              "--from-lowered-accept=compiler,options,inputs",
              quiet,
              copies,
            ],
            "scriptc: warning: --from-lowered: building from " +
              seedIr +
              " although its compiler differs: the file holds only an IR module, which does not record its compiler\n" +
              "scriptc: warning: --from-lowered: building from " +
              seedIr +
              " although its options differ: the file holds only an IR module, which does not record its options\n" +
              "scriptc: warning: --from-lowered: building from " +
              seedIr +
              " although its inputs differ: the file holds only an IR module, which does not record its inputs\n",
          ),
        );
        expect(self.trim()).toBe(rebuilt);
        await settle([compareArtifacts({ ir: false, llvm: true }), probeRebuilt()]);
      };
      await runNativeBootstrapChecks(plan, {
        commands: () => bootstrapStep("seed command and library probes", seedChecks),
        rebuild: rebuildChecks,
        "rebuild-frontend": rebuildFrontend,
        "rebuild-emit": rebuildEmit,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  // The plain rebuild phase took up to 3892 s with a seed built in 1800 s or less.
  sanitize ? 10_800_000 : 7_200_000,
);
