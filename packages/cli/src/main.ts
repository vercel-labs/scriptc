import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze, buildTargetPlatform, compile, compileC, compileLibrary, isExactExternalTypeSpecifier, renderAll, renderCoverage, resolveProvenanceSources, setProvenanceSources } from "@scriptc/compiler";
import { defaultExecutableName } from "./paths.js";

const USAGE = `scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to an executable target artifact
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --dynamic  what a --dynamic build compiles, and what still blocks it
  scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>
                                            type-resolve an embedder-provided module for analysis
  scriptc build --lib --profile <p.json>    library mode: compile the profile's entry
                                            module to a linkable static archive
                                            (<name>.lib.a) exporting the
                                            profile-declared C symbols; a profile
                                            with a sidecar section also gets the
                                            contract sidecar JSON beside the archive

Options:
  -o, --out <path>   output path (default: .scriptc/<name>[.exe|.wasm])
      --backend <b>  code generator. llvm is the default and the output that
                     ships; c emits readable C for inspecting what the
                     compiler produced, and program behavior is identical
                     either way. On native targets, a program outside the LLVM tier still
                     builds — the default lane emits C for it and a one-line
                     stderr note names the construct — while an explicit
                     --backend llvm fails with that construct named
                     wasm32-wasi is LLVM-only unless --backend c is explicit;
                     its C inspection lane accepts async-free programs only
      --from-c       treat input as a C (or .ll) file (toolchain plumbing/debugging)
      --keep-c       keep the generated program TU next to the executable
                     (default; the .ll — or the .c under --backend=c or
                     when the build fell back)
      --no-keep-c    delete the generated program TU after compiling
      --emit-ir      also write the IR as JSON next to the executable
      --sanitize     build with ASan + runtime RC audit
      --dynamic      embed the dynamic engine (adds ~620KB; static stays the default)
      --ffi <file>   bind signature-only TypeScript declarations to native
                     C symbols and link the manifest's archives/libraries
      --npm-static <pkg[,pkg…]|auto>
                     compile the named npm packages' shipped JS statically as
                     program modules (repeatable; "auto" opts in every eligible
                     direct import: own .d.ts, unminified JS, no build-transform
                     markers). A package preflight refuses falls back to the
                     island (--dynamic) with a coverage-report note — opt-in,
                     experimental
      --provenance-sources
                     EXPERIMENTAL: compile npm dependencies from their
                     provenance-attested SOURCE (fetched at the attested
                     commit) as static program modules; packages without a
                     usable attestation keep the island path (a note, never
                     a failure)
      --external-types <specifier=file.d.ts>
                     coverage only: map an exact bare module specifier to a
                     local declaration file. The declaration supplies types
                     for analysis; the host module remains an explicit
                     external-boundary blocker (repeatable)
  -h, --help         show this help
  -v, --version      print the version
`;

/** The version of the installed package. Read from the manifest rather than
 * baked in by the build, so a stamped release and a source checkout answer
 * the same way. */
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/main.js at install time, src/main.ts under tsx: the manifest is
  // one level up from either.
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

/* The exit discipline: NEVER process.exit() after writing output. stdout/
 * stderr to a PIPE are async streams — process.exit() drops whatever libuv
 * hasn't flushed yet, which truncates large diagnostic renders at the pipe
 * buffer (observed: 64KB cut mid-code-frame). Every path sets
 * process.exitCode and returns instead; Node exits naturally once the
 * streams drain. */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new CliExit(1);
}

/** parseArgs, with its throw turned into the CLI's own one-line error.
 * Unparseable arguments are a USER error — an unknown flag or a missing
 * value used to reach the top level as an uncaught ERR_PARSE_ARGS_* and
 * print a Node stack trace over the user's terminal. */
function parseCli(): ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>> {
  try {
    return parseArgs({ options: CLI_OPTIONS, allowPositionals: true, allowNegative: true });
  } catch (err) {
    // parseArgs appends a paragraph about `--` and positionals to the
    // unknown-option message; the first sentence is the part that names
    // what was wrong, and USAGE below already covers what was meant.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.split("\n")[0]!.split(". ")[0]!;
    fail(`scriptc: ${msg}\n\n${USAGE}`);
  }
}

const CLI_OPTIONS = {
  out: { type: "string", short: "o" },
  // No parseArgs default: unset means the compiler's default lane
  // (LLVM with the transparent C fallback); an explicit value pins.
  backend: { type: "string" },
  "from-c": { type: "boolean", default: false },
  "keep-c": { type: "boolean", default: true },
  "emit-ir": { type: "boolean", default: false },
  sanitize: { type: "boolean", default: false },
  dynamic: { type: "boolean", default: false },
  ffi: { type: "string" },
  "npm-static": { type: "string", multiple: true },
  "provenance-sources": { type: "boolean", default: false },
  "external-types": { type: "string", multiple: true },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

async function main(): Promise<number> {
  const { values, positionals } = parseCli();
  const externalTypeArgs = values["external-types"] ?? [];

  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const [command, inputArg] = positionals;
  if (command !== "build" && command !== "run" && command !== "coverage") {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
  if (values.lib) {
    // LIBRARY mode: the profile names the entry module and pins the
    // emission; the executable lane's mode flags have no meaning here
    // (library artifacts are static-tier only, and there is no fallback
    // concept — bare npm specifiers are static-or-refuse: the npm-static
    // eligibility bar runs automatically, eligible packages compile into
    // the graph, ineligible ones refuse with SC4013).
    if (command !== "build") fail(`--lib is a build mode (scriptc build --lib --profile <p.json>)\n\n${USAGE}`);
    const profileArg = values.profile;
    if (!profileArg) fail(`scriptc build --lib needs --profile <profile.json>\n\n${USAGE}`);
    if (inputArg) {
      fail("scriptc build --lib takes no input positional: the profile names the entry module");
    }
    if (values.dynamic || values.backend !== undefined || values.ffi !== undefined || (values["npm-static"] ?? []).length > 0 || externalTypeArgs.length > 0) {
      fail(
        "scriptc build --lib takes no --dynamic/--backend/--npm-static/--ffi/--external-types: the profile pins the emission, npm imports are judged automatically, outbound FFI belongs to executable builds, and external type mappings belong to coverage",
      );
    }
    const profilePath = resolve(profileArg);
    const libOutDir = values.out ? dirname(resolve(values.out)) : join(dirname(profilePath), ".scriptc");
    const result = await compileLibrary({
      profilePath,
      outDir: libOutDir,
      ...(values.out ? { outPath: resolve(values.out) } : {}),
      emitIr: values["emit-ir"],
      sanitize: values.sanitize,
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderAll(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      return 1;
    }
    if (!values["keep-c"]) rmSync(result.cPath, { force: true });
    process.stdout.write(`${result.archivePath}\n`);
    // The contract sidecar rides the same invocation when the profile
    // declares one — name it so the embedder's tooling knows where to look.
    if (result.sidecarPath !== undefined) process.stdout.write(`${result.sidecarPath}\n`);
    return 0;
  }
  if (!inputArg) fail(`missing input file\n\n${USAGE}`);
  const input = resolve(inputArg);
  if (externalTypeArgs.length > 0 && command !== "coverage") {
    fail(`--external-types is a coverage-only option\n\n${USAGE}`);
  }
  const externalTypes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const mapping of externalTypeArgs) {
    const equals = mapping.indexOf("=");
    if (equals <= 0 || equals === mapping.length - 1) {
      fail(`invalid --external-types mapping ${JSON.stringify(mapping)} (expected <specifier=file.d.ts>)`);
    }
    const specifier = mapping.slice(0, equals).trim();
    const declarationArg = mapping.slice(equals + 1).trim();
    if (!isExactExternalTypeSpecifier(specifier)) {
      fail(`invalid --external-types specifier ${JSON.stringify(specifier)} (expected an exact bare package specifier)`);
    }
    if (!/\.d\.(?:ts|mts|cts)$/.test(declarationArg)) {
      fail(`invalid --external-types declaration ${JSON.stringify(declarationArg)} (expected a .d.ts, .d.mts, or .d.cts file)`);
    }
    if (externalTypes[specifier] !== undefined) {
      fail(`duplicate --external-types mapping for ${JSON.stringify(specifier)}`);
    }
    const declarationPath = resolve(declarationArg);
    try {
      if (!statSync(declarationPath).isFile()) throw new Error("not a file");
    } catch {
      fail(`--external-types declaration does not name a readable file: ${declarationPath}`);
    }
    externalTypes[specifier] = declarationPath;
  }
  const ffiProfilePath = values.ffi !== undefined ? resolve(values.ffi) : undefined;
  const backend = values.backend;
  if (backend !== undefined && backend !== "c" && backend !== "llvm") {
    fail(`unknown backend "${backend}" (supported: c, llvm)\n\n${USAGE}`);
  }

  // --npm-static: repeatable and comma-splittable; the literal "auto"
  // switches to eligibility-based detection (mixing "auto" with names
  // is rejected — the shapes answer different questions).
  const npmStaticRaw = (values["npm-static"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1) fail(`--npm-static auto cannot be combined with package names\n\n${USAGE}`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // --provenance-sources resolves BEFORE the program loads (tsgo needs the
  // source "paths" at creation): attestations and source trees fetch (or
  // ride the content-addressed cache / the offline manifest), the registry
  // installs, and every fallback prints as a note — never a failure.
  const provenance = values["provenance-sources"] ? await resolveProvenanceSources(input) : null;
  if (provenance !== null) {
    setProvenanceSources(provenance);
    for (const pkg of provenance.packages) {
      process.stderr.write(
        `provenance: ${pkg.name}@${pkg.version} ← ${pkg.repo.replace(/^git\+/, "")} @ ${pkg.commit.slice(0, 12)} (source compiles statically)\n`,
      );
    }
    for (const note of provenance.notes) process.stderr.write(`provenance: ${note}\n`);
  }

  if (command === "coverage") {
    const { coverage, sourceTexts } = analyze(input, {
      dynamic: values.dynamic,
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(Object.keys(externalTypes).length > 0 ? { externalTypes } : {}),
    });
    const color = process.stdout.isTTY ?? false;
    process.stdout.write(renderCoverage(coverage, { color, sourceTexts }) + "\n");
    return coverage.preflightFailed ? 1 : 0;
  }

  const outDir = values.out ? dirname(resolve(values.out)) : join(dirname(input), ".scriptc");
  const stem = basename(input).replace(/\.(ts|js|mjs|cjs|c|ll)$/, "");
  const outPath = values.out ? resolve(values.out) : join(outDir, defaultExecutableName(stem));

  const build = async (): Promise<string> => {
    if (values["from-c"]) {
      if (ffiProfilePath !== undefined) {
        fail("--ffi is a TypeScript/JavaScript compiler feature and cannot be combined with --from-c");
      }
      await compileC({ cPath: input, outPath, sanitize: values.sanitize, dynamic: values.dynamic });
      return outPath;
    }
    const result = await compile(input, {
      outPath,
      outDir,
      emitIr: values["emit-ir"],
      sanitize: values.sanitize,
      dynamic: values.dynamic,
      ...(backend !== undefined ? { backend } : {}),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderAll(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      throw new CliExit(1);
    }
    // The lane-change note: the ONLY case where silence would be dishonest
    // is the default lane quietly building through C — one stderr line
    // names the refusal. A successful LLVM build is the documented default
    // (and the kept .ll next to the binary is the durable record), and an
    // explicit --backend was the user's own choice — neither gets a line.
    if (result.llvmRefusal !== undefined) {
      process.stderr.write(`scriptc: backend c (llvm refused: ${result.llvmRefusal})\n`);
    }
    if (!values["keep-c"]) rmSync(result.cPath, { force: true });
    return result.binaryPath;
  };

  const binary = await build();

  if (command === "run") {
    return new Promise<number>((resolveExit) => {
      let child;
      if (buildTargetPlatform() === "wasi") {
        const builtRunner = fileURLToPath(new URL("./wasi-runner.js", import.meta.url));
        const runner = existsSync(builtRunner)
          ? builtRunner
          : fileURLToPath(new URL("./wasi-runner.ts", import.meta.url));
        child = spawn(
          process.execPath,
          [...process.execArgv, "--no-warnings", runner, binary],
          { stdio: "inherit" },
        );
      } else {
        child = spawn(binary, [], { stdio: "inherit" });
      }
      child.on("exit", (code, signal) => {
        if (signal) {
          process.stderr.write(`scriptc: program killed by ${signal}\n`);
          resolveExit(1);
        } else {
          resolveExit(code ?? 0);
        }
      });
    });
  }
  process.stdout.write(`${binary}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CliExit) process.exitCode = err.code;
  else throw err;
}
