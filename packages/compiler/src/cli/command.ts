import { rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isExactExternalTypeSpecifier } from "../frontend/program.js";
import { renderDiagnostics } from "../diagnostics/render.js";
import {
  coverageEnvelope,
  coveragePasses,
  renderCoverage,
  type CoverageFailOn,
} from "../coverage/report.js";
import { buildEnvelope } from "../diagnostics/envelope.js";
import { renderWarnings } from "../diagnostics/render.js";
import { isNativeOptimization } from "../backend/optimization.js";
import { setProvenanceSources } from "../frontend/provenance-registry.js";
import type { CliHost, NativeCacheWarmProfile } from "./host.js";
import { resolveOutputOptions } from "./output-options.js";
import { selectOutputPaths } from "./paths.js";
import { CLI_OPTIONS, USAGE } from "./usage.js";

/* The exit discipline: NEVER process.exit() after writing output. stdout/
 * stderr to a PIPE are async streams — process.exit() drops whatever libuv
 * hasn't flushed yet, which truncates large diagnostic renders at the pipe
 * buffer (observed: 64KB cut mid-code-frame). Every path sets
 * process.exitCode and returns instead; Node exits naturally once the
 * streams drain. */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "CliExit";
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
function parseCli(
  args: string[],
): ReturnType<
  typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>
> {
  try {
    return parseArgs({ args, options: CLI_OPTIONS, allowPositionals: true, allowNegative: true });
  } catch (err) {
    // parseArgs appends a paragraph about `--` and positionals to the
    // unknown-option message; the first sentence is the part that names
    // what was wrong, and USAGE below already covers what was meant.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.split("\n")[0]!.split(". ")[0]!;
    fail(`scriptc: ${msg}\n\n${USAGE}`);
  }
}

async function main(args: string[], host: CliHost): Promise<number> {
  const { values, positionals } = parseCli(args);
  const externalTypeArgs = values["external-types"] ?? [];

  if (values.version) {
    process.stdout.write(`${host.version()}\n`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const [command, inputArg] = positionals;
  if (command === "cache") {
    if (inputArg !== "warm")
      fail(`unknown cache command "${inputArg ?? ""}" (supported: warm)\n\n${USAGE}`);
    if (
      values.lib ||
      values.dynamic ||
      values.backend !== undefined ||
      values.emit !== undefined ||
      values.print !== undefined ||
      values["fail-on"] !== undefined ||
      values.ffi !== undefined ||
      values.profile !== undefined ||
      values.strip ||
      values["windows-subsystem"] !== undefined ||
      (values["npm-static"] ?? []).length > 0 ||
      values["provenance-sources"] ||
      externalTypeArgs.length > 0 ||
      values.out !== undefined ||
      values["emit-ir"] ||
      !values["keep-llvm"]
    ) {
      fail(
        `scriptc cache warm takes only native optimization/sanitizer options and profile names\n\n${USAGE}`,
      );
    }
    const optimization = values.optimization;
    if (optimization !== undefined && !isNativeOptimization(optimization)) {
      fail(`unknown optimization "${optimization}" (supported: release, dev, speed)\n\n${USAGE}`);
    }
    const profileArgs = positionals.slice(2);
    const knownProfiles = new Set<NativeCacheWarmProfile>(["runtime", "tls", "dynamic"]);
    for (const profile of profileArgs) {
      if (!knownProfiles.has(profile as NativeCacheWarmProfile)) {
        fail(`unknown cache warm profile "${profile}" (supported: runtime, tls, dynamic)`);
      }
    }
    let result;
    try {
      result = await host.warmNativeCaches({
        ...(optimization === undefined ? {} : { optimization }),
        sanitize: values.sanitize,
        ...(profileArgs.length === 0 ? {} : { profiles: profileArgs as NativeCacheWarmProfile[] }),
      });
    } catch (error) {
      fail(`scriptc: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${result.cacheRoot}\n`);
    for (const profile of result.profiles) {
      process.stdout.write(`${profile.profile}\t${Math.round(profile.elapsedMs)}ms\n`);
    }
    return 0;
  }
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
    if (command !== "build")
      fail(`--lib is a build mode (scriptc build --lib --profile <p.json>)\n\n${USAGE}`);
    const profileArg = values.profile;
    if (!profileArg) fail(`scriptc build --lib needs --profile <profile.json>\n\n${USAGE}`);
    if (inputArg) {
      fail("scriptc build --lib takes no input positional: the profile names the entry module");
    }
    if (
      values.dynamic ||
      values.backend !== undefined ||
      values.emit !== undefined ||
      values.print !== undefined ||
      values["fail-on"] !== undefined ||
      values.optimization !== undefined ||
      values.strip ||
      values.ffi !== undefined ||
      values["windows-subsystem"] !== undefined ||
      (values["npm-static"] ?? []).length > 0 ||
      externalTypeArgs.length > 0
    ) {
      fail(
        "scriptc build --lib takes no --dynamic/--backend/--emit/--print/--optimization/--strip/--windows-subsystem/--npm-static/--ffi/--external-types: the profile pins the emission and optimization, npm imports are judged automatically, outbound FFI belongs to executable builds, and external type mappings belong to coverage",
      );
    }
    const profilePath = resolve(profileArg);
    const libOutDir = values.out
      ? dirname(resolve(values.out))
      : join(dirname(profilePath), ".scriptc");
    const result = await host.compileLibrary({
      profilePath,
      outDir: libOutDir,
      ...(values.out ? { outPath: resolve(values.out) } : {}),
      emitIr: values["emit-ir"],
      sanitize: values.sanitize,
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(
        renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n",
      );
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      return 1;
    }
    if (!values["keep-llvm"]) rmSync(result.llvmPath, { force: true });
    process.stdout.write(`${result.archivePath}\n`);
    // The contract sidecar rides the same invocation when the profile
    // declares one — name it so the embedder's tooling knows where to look.
    if (result.sidecarPath !== undefined) process.stdout.write(`${result.sidecarPath}\n`);
    return 0;
  }
  if (values["emit-ir"] && (command === "build" || command === "run")) {
    process.stderr.write(
      "scriptc: warning: --emit-ir is deprecated; use --emit=ir for IR as the primary output\n",
    );
  }
  if (!inputArg) fail(`missing input file\n\n${USAGE}`);
  const input = resolve(inputArg);
  if (command === "coverage" && values.emit !== undefined) {
    fail(`--emit is a build/run option\n\n${USAGE}`);
  }
  if (command === "coverage" && values.strip) {
    fail(`--strip is a build/run option\n\n${USAGE}`);
  }
  if (
    values.print !== undefined &&
    values.print !== "native-link-info" &&
    values.print !== "diagnostics"
  ) {
    fail(
      `unknown print kind "${values.print}" (supported: native-link-info, diagnostics)\n\n${USAGE}`,
    );
  }
  const printNativeLinkInfo = values.print === "native-link-info";
  const printDiagnostics = values.print === "diagnostics";
  if (printDiagnostics && command === "run") {
    fail(`--print=diagnostics is a build/coverage option\n\n${USAGE}`);
  }
  const failOnRaw = values["fail-on"];
  if (failOnRaw !== undefined && failOnRaw !== "blockers" && failOnRaw !== "divergences") {
    fail(`unknown --fail-on value "${failOnRaw}" (supported: blockers, divergences)\n\n${USAGE}`);
  }
  if (failOnRaw !== undefined && command !== "coverage") {
    fail(`--fail-on is a coverage option (a build already fails on blockers)\n\n${USAGE}`);
  }
  const failOn = failOnRaw as CoverageFailOn | undefined;
  if (printNativeLinkInfo && command !== "build") {
    fail(`--print=native-link-info is a build option\n\n${USAGE}`);
  }
  if (printNativeLinkInfo && values.emit !== undefined && values.emit !== "obj") {
    fail(`--print=native-link-info requires --emit=obj\n\n${USAGE}`);
  }
  if (externalTypeArgs.length > 0 && command !== "coverage") {
    fail(`--external-types is a coverage-only option\n\n${USAGE}`);
  }
  const externalTypes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const mapping of externalTypeArgs) {
    const equals = mapping.indexOf("=");
    if (equals <= 0 || equals === mapping.length - 1) {
      fail(
        `invalid --external-types mapping ${JSON.stringify(mapping)} (expected <specifier=file.d.ts>)`,
      );
    }
    const specifier = mapping.slice(0, equals).trim();
    const declarationArg = mapping.slice(equals + 1).trim();
    if (!isExactExternalTypeSpecifier(specifier)) {
      fail(
        `invalid --external-types specifier ${JSON.stringify(specifier)} (expected an exact bare package specifier)`,
      );
    }
    if (!/\.d\.(?:ts|mts|cts)$/.test(declarationArg)) {
      fail(
        `invalid --external-types declaration ${JSON.stringify(declarationArg)} (expected a .d.ts, .d.mts, or .d.cts file)`,
      );
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
  if (values.backend !== undefined && values.backend !== "llvm") {
    fail(`unknown backend "${values.backend}" (supported: llvm)\n\n${USAGE}`);
  }
  const optimization = values.optimization;
  if (optimization !== undefined && !isNativeOptimization(optimization)) {
    fail(`unknown optimization "${optimization}" (supported: release, dev, speed)\n\n${USAGE}`);
  }
  const windowsSubsystem = values["windows-subsystem"];
  if (
    windowsSubsystem !== undefined &&
    windowsSubsystem !== "console" &&
    windowsSubsystem !== "gui"
  ) {
    fail(`unknown Windows subsystem "${windowsSubsystem}" (supported: console, gui)\n\n${USAGE}`);
  }
  if (windowsSubsystem !== undefined && command === "coverage") {
    fail(`--windows-subsystem is only supported for executable builds\n\n${USAGE}`);
  }
  const output =
    command === "coverage"
      ? null
      : resolveOutputOptions(command, {
          ...(values.emit === undefined && !printNativeLinkInfo
            ? {}
            : { emit: values.emit ?? "obj" }),
          emitIr: values["emit-ir"],
          ...(values.backend === undefined ? {} : { backend: values.backend }),
          keepLlvm: values["keep-llvm"],
          sanitize: values.sanitize,
          ...(values.optimization === undefined ? {} : { optimization: values.optimization }),
          strip: values.strip,
          ...(windowsSubsystem === undefined ? {} : { windowsSubsystem }),
          ...(values.ffi === undefined ? {} : { ffi: values.ffi }),
        });
  if (output !== null && !output.ok) fail(`${output.message}\n\n${USAGE}`);
  const backend = output === null ? undefined : output.backend;

  // --npm-static: repeatable and comma-splittable; the literal "auto"
  // switches to eligibility-based detection (mixing "auto" with names
  // is rejected — the shapes answer different questions).
  const npmStaticRaw = (values["npm-static"] ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1)
      fail(`--npm-static auto cannot be combined with package names\n\n${USAGE}`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // --provenance-sources resolves BEFORE the program loads (tsgo needs the
  // source "paths" at creation): attestations and source trees fetch (or
  // ride the content-addressed cache / the offline manifest), the registry
  // installs, and every fallback prints as a note — never a failure.
  const provenance = values["provenance-sources"]
    ? await host.resolveProvenanceSources(input)
    : null;
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
    const { coverage, sourceTexts } = await host.analyze(input, {
      dynamic: values.dynamic,
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(Object.keys(externalTypes).length > 0 ? { externalTypes } : {}),
    });
    if (printDiagnostics) {
      // Keep stdout pure JSON for tooling.
      const envelope = coverageEnvelope(coverage, {
        compilerVersion: host.version(),
        sourceTexts,
        ...(failOn === undefined ? {} : { failOn }),
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      const color = process.stdout.isTTY ?? false;
      process.stdout.write(
        renderCoverage(coverage, { color, sourceTexts, root: process.cwd() }) + "\n",
      );
    }
    return coveragePasses(coverage, failOn) ? 0 : 1;
  }

  if (output === null || !output.ok) throw new Error("internal output-option state");
  if (windowsSubsystem !== undefined && host.sourceTargetPlatform() !== "win32") {
    fail(`--windows-subsystem requires a Windows executable target\n\n${USAGE}`);
  }
  const { outDir, outPath } = selectOutputPaths(
    input,
    output.cliOutputKind,
    values.out,
    output.cliOutputKind === "exe" ? host.sourceTargetPlatform() : undefined,
  );

  let nativeLinkInfo: object | undefined;
  let diagnosticsEnvelope: object | undefined;
  const build = async (): Promise<string> => {
    const result = await host.compile(input, {
      outPath,
      outDir,
      outputKind: output.outputKind,
      emitIr: output.emitIr,
      sanitize: values.sanitize,
      dynamic: values.dynamic,
      ...(backend !== undefined ? { backend } : {}),
      ...(optimization !== undefined ? { optimization } : {}),
      ...(values.strip ? { strip: true } : {}),
      ...(windowsSubsystem !== undefined ? { windowsSubsystem } : {}),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(printNativeLinkInfo ? { nativeLinkInfo: true } : {}),
    });
    if (!result.ok) {
      if (printDiagnostics) {
        const envelope = buildEnvelope({
          compilerVersion: host.version(),
          entry: input,
          ok: false,
          diagnostics: result.diagnostics,
          sourceTexts: result.sourceTexts,
        });
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
        throw new CliExit(1);
      }
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(
        renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n",
      );
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      throw new CliExit(1);
    }
    const warnings = result.warnings ?? [];
    if (printDiagnostics) {
      diagnosticsEnvelope = buildEnvelope({
        compilerVersion: host.version(),
        entry: input,
        ok: true,
        artifact: result.artifact.path,
        diagnostics: [],
        warnings,
        ...(result.sourceTexts === undefined ? {} : { sourceTexts: result.sourceTexts }),
      });
    } else if (warnings.length > 0 && command === "build") {
      // Divergence warnings never fail a build; they explain where the
      // native program can behave differently from Node. `run` keeps
      // stderr for the program's own output.
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(
        renderWarnings(warnings, result.sourceTexts ?? new Map(), { color }) + "\n",
      );
    }
    if (result.artifact.kind === "exe") {
      if (!values["keep-llvm"]) rmSync(result.artifact.translationUnitPath, { force: true });
    } else if (result.artifact.kind === "obj") {
      nativeLinkInfo = result.artifact.nativeLinkInfo;
    }
    return result.artifact.path;
  };

  const binary = await build();

  if (command === "run") {
    return host.run(binary);
  }

  if (printDiagnostics) {
    process.stdout.write(`${JSON.stringify(diagnosticsEnvelope, null, 2)}\n`);
  } else if (printNativeLinkInfo) {
    if (nativeLinkInfo === undefined) throw new Error("internal native-link-info state");
    // Keep stdout pure JSON for tooling; the ordinary artifact path is in
    // program.object inside the document.
    process.stdout.write(`${JSON.stringify(nativeLinkInfo, null, 2)}\n`);
  } else {
    process.stdout.write(`${binary}\n`);
  }
  return 0;
}

/** Both installed and seed commands use this argument and diagnostic contract. */
export async function runCli(args: string[], host: CliHost): Promise<number> {
  try {
    return await main(args, host);
  } catch (err) {
    if (err instanceof Error && err.name === "CliExit") return Number(err.message.slice(5));
    throw err;
  }
}
