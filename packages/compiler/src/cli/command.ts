import type { TypePatchCommandRequest } from "../frontend/type-patches/command.js";
import { rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isExactExternalTypeSpecifier } from "../frontend/program.js";
import { renderDiagnostics } from "../diagnostics/render.js";
import {
  COVERAGE_FAIL_ON,
  coverageEnvelope,
  coveragePasses,
  renderCoverage,
  renderExplainDynamic,
  renderExplainIsland,
  type CoverageFailOn,
} from "../coverage/report.js";
import {
  NODE_ISLANDS_MODES,
  type NodeIslandOptions,
  type NodeIslandsMode,
} from "../node-islands/policy.js";
import { TIER_MODES, type TierMode } from "../frontend/tier-analysis.js";
import { buildEnvelope } from "../diagnostics/envelope.js";
import {
  renderConfigWarnings,
  renderTypePatchWarnings,
  renderWarnings,
} from "../diagnostics/render.js";
import { isTypePatchCode } from "../diagnostics/diagnostic.js";
import { isPerformanceCode, renderPerformanceWarnings } from "../diagnostics/dynamic-tier.js";
import { isNativeOptimization } from "../backend/optimization.js";
import { renderNativeProfileMatch } from "../backend/native-profile.js";
import {
  hostTargetCpu,
  isTargetCpuOption,
  TARGET_CPU_OPTIONS,
  targetCpuField,
  type TargetCpu,
} from "../backend/target-cpu.js";
import { setProvenanceSources } from "../frontend/provenance-registry.js";
import type { CliHost, NativeCacheWarmProfile } from "./host.js";
import { resolveOutputOptions } from "./output-options.js";
import { selectOutputPaths } from "./paths.js";
import { serveMcp } from "./mcp.js";
import {
  CLI_COMMANDS,
  CLI_OPTIONS,
  cliOptionSpellings,
  programArgumentsStart,
  USAGE,
} from "./usage.js";

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

/** A command line scriptc cannot act on: the message, then where the help
 * is. The help itself is some 200 lines, and printing it after the message
 * scrolls the message off the screen. */
function usageError(msg: string): never {
  fail(`${msg}\nRun 'scriptc --help' for the commands and options.`);
}

/** The number of edits that turn `a` into `b`: a character inserted, removed
 * or replaced, or two neighbours swapped. */
function editDistance(a: string, b: string): number {
  // rows[i][j] is the distance between the first i characters of a and the
  // first j of b.
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        row.push(j);
        continue;
      }
      const same = a.charAt(i - 1) === b.charAt(j - 1);
      let best = Math.min(
        rows[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        rows[i - 1]![j - 1]! + (same ? 0 : 1),
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charAt(i - 1) === b.charAt(j - 2) &&
        a.charAt(i - 2) === b.charAt(j - 1)
      )
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      row.push(best);
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

/** The candidate a mistyped `name` most likely meant: the closest one within
 * a third of the name's length in edits, or else the only candidate that
 * `name` abbreviates or extends. Null when nothing is close. */
function nearest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best !== null || name.length < 3) return best;
  const related = candidates.filter(
    (candidate) => candidate.startsWith(name) || name.startsWith(candidate),
  );
  return related.length === 1 ? related[0]! : null;
}

/** `--explain-dynamic` takes an optional value: alone it lists every unit. */
function withOptionalValues(args: readonly string[]): string[] {
  return args.map((arg) => (arg === "--explain-dynamic" ? "--explain-dynamic=" : arg));
}

/** parseArgs, with its throw turned into the CLI's own short error.
 * Unparseable arguments are a USER error — an unknown flag or a missing
 * value used to reach the top level as an uncaught ERR_PARSE_ARGS_* and
 * print a Node stack trace over the user's terminal. */
function parseCli(
  args: string[],
): ReturnType<
  typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>
> {
  try {
    return parseArgs({
      args,
      options: CLI_OPTIONS,
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (err) {
    // parseArgs appends a paragraph about `--` and positionals to the
    // unknown-option message; the first sentence is the part that names
    // what was wrong.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.split("\n")[0]!.split(". ")[0]!;
    const unknown = /^Unknown option '--([^'=]+)/.exec(msg);
    const meant = unknown === null ? null : nearest(unknown[1]!, cliOptionSpellings());
    usageError(`scriptc: ${msg}${meant === null ? "" : `\n  did you mean '--${meant}'?`}`);
  }
}

/** What an unknown command most likely meant: a file to run, or a command
 * spelled differently. */
function unknownCommandHint(command: string): string {
  if (/\.(?:[cm]?[jt]s)$/.test(command))
    return `\n  to compile and run a file: scriptc run ${command}`;
  const commands = [...new Set(CLI_COMMANDS.map((candidate) => candidate.argv[0]!)), "mcp"];
  const meant = nearest(command, commands);
  return meant === null ? "" : `\n  did you mean '${meant}'?`;
}

async function main(args: string[], host: CliHost): Promise<number> {
  // `scriptc run`: what follows the entry file is the program's, as written.
  const ownArgs = withOptionalValues(args);
  const programStart = programArgumentsStart(ownArgs);
  const programArgs = args.slice(programStart);
  const { values, positionals } = parseCli(ownArgs.slice(0, programStart));
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
  if (command === "mcp") {
    if (args.length !== 1) usageError(`scriptc mcp takes no arguments`);
    return serveMcp(host);
  }
  if (command === "cache") {
    if (inputArg !== "warm")
      usageError(`unknown cache command "${inputArg ?? ""}" (supported: warm)`);
    if (
      values.lib ||
      values.backend !== undefined ||
      values.emit !== undefined ||
      values.print !== undefined ||
      values["fail-on"] !== undefined ||
      values.ffi !== undefined ||
      values.profile !== undefined ||
      values.strip ||
      values.static ||
      values["windows-subsystem"] !== undefined ||
      values["detached-exit"] ||
      values["large-pages"] ||
      values["stdout-buffering"] ||
      values.exceptions !== undefined ||
      values["target-cpu"] !== undefined ||
      values["cpu-dispatch"] !== undefined ||
      values["profile-generate"] !== undefined ||
      values["profile-use"] !== undefined ||
      values.sparse ||
      (values["npm-static"] ?? []).length > 0 ||
      values["provenance-sources"] ||
      externalTypeArgs.length > 0 ||
      values.out !== undefined ||
      values["emit-ir"] ||
      values.tier !== undefined ||
      values["explain-dynamic"] !== undefined ||
      hasNodeIslandFlags(values) ||
      !values["keep-llvm"]
    ) {
      usageError(
        `scriptc cache warm takes only native optimization/sanitizer options and profile names`,
      );
    }
    const optimization = values.optimization;
    if (optimization !== undefined && !isNativeOptimization(optimization)) {
      usageError(`unknown optimization "${optimization}" (supported: release, dev, speed)`);
    }
    const profileArgs = positionals.slice(2);
    const knownProfiles = new Set<NativeCacheWarmProfile>(["runtime", "tls"]);
    for (const profile of profileArgs) {
      if (!knownProfiles.has(profile as NativeCacheWarmProfile)) {
        fail(`unknown cache warm profile "${profile}" (supported: runtime, tls)`);
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
  if (command === "merge-profiles") {
    const inputs = positionals.slice(1);
    const others =
      values.lib ||
      values.backend !== undefined ||
      values.emit !== undefined ||
      values.print !== undefined ||
      values["fail-on"] !== undefined ||
      values.optimization !== undefined ||
      values.ffi !== undefined ||
      values.profile !== undefined ||
      values.strip ||
      values.static ||
      values.sanitize ||
      values["windows-subsystem"] !== undefined ||
      values["detached-exit"] ||
      values["large-pages"] ||
      values["stdout-buffering"] ||
      values.exceptions !== undefined ||
      values["target-cpu"] !== undefined ||
      values["cpu-dispatch"] !== undefined ||
      values["profile-generate"] !== undefined ||
      values["profile-use"] !== undefined ||
      (values["npm-static"] ?? []).length > 0 ||
      values["provenance-sources"] ||
      externalTypeArgs.length > 0 ||
      (values.wasm ?? []).length > 0 ||
      values["emit-ir"] ||
      values.tier !== undefined ||
      values["explain-dynamic"] !== undefined ||
      hasNodeIslandFlags(values) ||
      !values["keep-llvm"];
    if (values.out === undefined || inputs.length === 0 || others) {
      usageError(
        `scriptc merge-profiles takes -o <out.profdata>, optionally --sparse, and one or more profiles`,
      );
    }
    const outputPath = resolve(values.out);
    try {
      await host.mergeProfiles(
        outputPath,
        inputs.map((input) => resolve(input)),
        values.sparse,
      );
    } catch (error) {
      fail(`scriptc: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${outputPath}\n`);
    return 0;
  }
  if (command === "types") {
    const sub = positionals[1];
    const rest = positionals.slice(2);
    let request: TypePatchCommandRequest;
    if (sub === "patch" && rest.length === 3) {
      request = {
        action: "patch",
        cwd: process.cwd(),
        pkg: rest[0]!,
        selector: rest[1]!,
        type: rest[2]!,
        range: values.range ?? null,
        dryRun: values["dry-run"],
      };
    } else if (
      sub === "list" &&
      rest.length === 0 &&
      values.range === undefined &&
      !values["dry-run"]
    ) {
      request = { action: "list", cwd: process.cwd() };
    } else {
      usageError(
        `scriptc types takes "patch <package> <selector> <type>" (with --range or --dry-run) or "list"`,
      );
    }
    const result = await host.typePatches(request);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (values.range !== undefined || values["dry-run"])
    usageError(`--range and --dry-run are scriptc types patch options`);
  if (values.sparse) usageError(`--sparse is a merge-profiles option`);
  if (command !== "build" && command !== "run" && command !== "coverage") {
    usageError(`unknown command "${command}"${unknownCommandHint(command ?? "")}`);
  }
  if (values.lib) {
    // LIBRARY mode: the profile names the entry module and pins the
    // emission; the executable lane's mode flags have no meaning here
    // (library artifacts are static-tier only, and there is no fallback
    // concept — bare npm specifiers are static-or-refuse: the npm-static
    // eligibility bar runs automatically, eligible packages compile into
    // the graph, ineligible ones refuse with SC4013).
    if (command !== "build")
      usageError(`--lib is a build mode (scriptc build --lib --profile <p.json>)`);
    const profileArg = values.profile;
    if (!profileArg) usageError(`scriptc build --lib needs --profile <profile.json>`);
    if (inputArg) {
      fail("scriptc build --lib takes no input positional: the profile names the entry module");
    }
    if (
      values.backend !== undefined ||
      values.emit !== undefined ||
      values.print !== undefined ||
      values["fail-on"] !== undefined ||
      values.optimization !== undefined ||
      values.strip ||
      values.static ||
      values.ffi !== undefined ||
      values["windows-subsystem"] !== undefined ||
      values["detached-exit"] ||
      values["large-pages"] ||
      values["stdout-buffering"] ||
      values.exceptions !== undefined ||
      values["target-cpu"] !== undefined ||
      values["cpu-dispatch"] !== undefined ||
      values["profile-generate"] !== undefined ||
      values["profile-use"] !== undefined ||
      (values["npm-static"] ?? []).length > 0 ||
      externalTypeArgs.length > 0 ||
      values.tier !== undefined ||
      values["explain-dynamic"] !== undefined ||
      hasNodeIslandFlags(values)
    ) {
      fail(
        "scriptc build --lib takes no --backend/--emit/--print/--optimization/--strip/--static/--windows-subsystem/--detached-exit/--large-pages/--stdout-buffering/--exceptions/--target-cpu/--cpu-dispatch/--profile-generate/--profile-use/--npm-static/--ffi/--external-types/--tier/--explain-dynamic: the profile pins the emission and optimization, npm imports are judged automatically, outbound FFI belongs to executable builds, external type mappings belong to coverage, and library artifacts are static-tier only",
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
  if (!inputArg) usageError(`missing input file`);
  const input = resolve(inputArg);
  if (command === "coverage" && values.emit !== undefined) {
    usageError(`--emit is a build/run option`);
  }
  if (command === "coverage" && values.strip) {
    usageError(`--strip is a build/run option`);
  }
  if (command === "coverage" && values.static) {
    usageError(`--static is a build/run option`);
  }
  if (command === "coverage" && values["target-cpu"] !== undefined) {
    usageError(`--target-cpu is a build/run option`);
  }
  if (command === "coverage" && values["cpu-dispatch"] !== undefined) {
    usageError(`--cpu-dispatch is a build/run option`);
  }
  if (command === "coverage" && values["detached-exit"]) {
    usageError(`--detached-exit is a build/run option`);
  }
  if (command === "coverage" && values["stdout-buffering"]) {
    usageError(`--stdout-buffering is a build/run option`);
  }
  if (command === "coverage" && values["large-pages"]) {
    usageError(`--large-pages is a build/run option`);
  }
  if (command === "coverage" && values.exceptions !== undefined) {
    usageError(`--exceptions is a build/run option`);
  }
  const exceptions = values.exceptions;
  if (exceptions !== undefined && exceptions !== "common" && exceptions !== "rare") {
    usageError(`unknown exception frequency "${exceptions}" (supported: common, rare)`);
  }
  if (command === "coverage" && values["profile-generate"] !== undefined) {
    usageError(`--profile-generate is a build/run option`);
  }
  if (command === "coverage" && values["profile-use"] !== undefined) {
    usageError(`--profile-use is a build/run option`);
  }
  if (
    values.print !== undefined &&
    values.print !== "native-link-info" &&
    values.print !== "diagnostics"
  ) {
    usageError(`unknown print kind "${values.print}" (supported: native-link-info, diagnostics)`);
  }
  const printNativeLinkInfo = values.print === "native-link-info";
  const printDiagnostics = values.print === "diagnostics";
  if (printDiagnostics && command === "run") {
    usageError(`--print=diagnostics is a build/coverage option`);
  }
  const failOnRaw = values["fail-on"];
  if (failOnRaw !== undefined && !(COVERAGE_FAIL_ON as readonly string[]).includes(failOnRaw)) {
    usageError(
      `unknown --fail-on value "${failOnRaw}" (supported: ${COVERAGE_FAIL_ON.join(", ")})`,
    );
  }
  // --no-dynamic-tier-warning leaves out SC6101 (diagnostics/dynamic-tier.ts).
  const dynamicTierWarning = values["dynamic-tier-warning"] !== false;
  if (failOnRaw === "dynamic" && !dynamicTierWarning) {
    usageError(`--fail-on=dynamic checks the warning --no-dynamic-tier-warning leaves out`);
  }
  if (failOnRaw !== undefined && command !== "coverage") {
    usageError(`--fail-on is a coverage option (a build already fails on blockers)`);
  }
  const failOn = failOnRaw as CoverageFailOn | undefined;
  const tierRaw = values.tier;
  if (tierRaw !== undefined && !(TIER_MODES as readonly string[]).includes(tierRaw)) {
    usageError(`unknown --tier value "${tierRaw}" (supported: ${TIER_MODES.join(", ")})`);
  }
  const tier = tierRaw as TierMode | undefined;
  const explainDynamic = values["explain-dynamic"];
  if (explainDynamic !== undefined && command !== "coverage") {
    usageError(`--explain-dynamic is a coverage option`);
  }
  const explainIsland = values["explain-island"];
  if (explainIsland !== undefined && command !== "coverage") {
    usageError(`--explain-island is a coverage option`);
  }
  if (explainIsland === "") usageError(`--explain-island needs a package name`);
  if (values["strict-user-js"] && command !== "coverage") {
    usageError(`--strict-user-js is a coverage option`);
  }
  // The Node island policy's command-line half: build and run decide their
  // islands with it, and coverage reports them.
  const islandMode = values["node-islands"];
  if (islandMode !== undefined && !(NODE_ISLANDS_MODES as readonly string[]).includes(islandMode)) {
    usageError(
      `unknown --node-islands value "${islandMode}" (supported: ${NODE_ISLANDS_MODES.join(", ")})`,
    );
  }
  const listValues = (raw: string[] | undefined): string[] =>
    (raw ?? [])
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => v !== "");
  const islandArgs = listValues(values["node-island"]);
  const nativeArgs = listValues(values.native);
  for (const name of nativeArgs) {
    if (islandArgs.includes(name))
      usageError(`--native=${name} and --node-island=${name} contradict each other`);
  }
  if (values.node === "") usageError(`--node needs the path of a node executable`);
  const nodeIslands: NodeIslandOptions | undefined =
    islandMode === undefined &&
    islandArgs.length === 0 &&
    nativeArgs.length === 0 &&
    values.node === undefined &&
    !values["strict-user-js"]
      ? undefined
      : {
          ...(islandMode !== undefined ? { mode: islandMode as NodeIslandsMode } : {}),
          ...(islandArgs.length > 0 ? { islands: islandArgs } : {}),
          ...(nativeArgs.length > 0 ? { native: nativeArgs } : {}),
          ...(values.node !== undefined ? { node: resolve(values.node) } : {}),
          ...(values["strict-user-js"] ? { strictUserJs: true } : {}),
        };
  if (printNativeLinkInfo && command !== "build") {
    usageError(`--print=native-link-info is a build option`);
  }
  if (printNativeLinkInfo && values.emit !== undefined && values.emit !== "obj") {
    usageError(`--print=native-link-info requires --emit=obj`);
  }
  if (externalTypeArgs.length > 0 && command !== "coverage") {
    usageError(`--external-types is a coverage-only option`);
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
  const wasmArgs = values.wasm ?? [];
  if (wasmArgs.length > 0 && command !== "coverage") {
    usageError(`--wasm is a coverage-only option`);
  }
  const wasmFiles = wasmArgs.map((file) => resolve(file));
  const ffiProfilePath = values.ffi !== undefined ? resolve(values.ffi) : undefined;
  if (values.backend !== undefined && values.backend !== "llvm") {
    usageError(`unknown backend "${values.backend}" (supported: llvm)`);
  }
  const optimization = values.optimization;
  if (optimization !== undefined && !isNativeOptimization(optimization)) {
    usageError(`unknown optimization "${optimization}" (supported: release, dev, speed)`);
  }
  const windowsSubsystem = values["windows-subsystem"];
  if (
    windowsSubsystem !== undefined &&
    windowsSubsystem !== "console" &&
    windowsSubsystem !== "gui"
  ) {
    usageError(`unknown --windows-subsystem value "${windowsSubsystem}" (supported: console, gui)`);
  }
  if (windowsSubsystem !== undefined && command === "coverage") {
    usageError(`--windows-subsystem is only supported for executable builds`);
  }
  const targetCpuOption = values["target-cpu"];
  if (targetCpuOption !== undefined && !isTargetCpuOption(targetCpuOption)) {
    usageError(
      `unknown target CPU "${targetCpuOption}" (supported: ${TARGET_CPU_OPTIONS.join(", ")})`,
    );
  }
  let targetCpu: TargetCpu | undefined = targetCpuOption === "native" ? undefined : targetCpuOption;
  if (targetCpuOption === "native") {
    const level = hostTargetCpu();
    if (level === null)
      fail(`--target-cpu=native needs an x86-64 Linux or macOS build host; name a level instead`);
    targetCpu = level;
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
          staticLink: values.static,
          detachedExit: values["detached-exit"],
          stdoutBuffering: values["stdout-buffering"],
          largePages: values["large-pages"],
          ...(values["cpu-dispatch"] === undefined ? {} : { cpuDispatch: values["cpu-dispatch"] }),
          ...(values["profile-generate"] === undefined
            ? {}
            : { profileGenerate: values["profile-generate"] }),
          ...(values["profile-use"] === undefined ? {} : { profileUse: values["profile-use"] }),
          ...(windowsSubsystem === undefined ? {} : { windowsSubsystem }),
          ...(values.ffi === undefined ? {} : { ffi: values.ffi }),
        });
  if (output !== null && !output.ok) usageError(`${output.message}`);
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
      usageError(`--npm-static auto cannot be combined with package names`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // The frontend cannot load a missing entry and says so with an internal
  // error; a file that is not there is the user's to fix, in one line.
  let entryIsFile = false;
  try {
    entryIsFile = statSync(input).isFile();
  } catch {
    fail(`scriptc: entry file not found: ${input}`);
  }
  if (!entryIsFile) fail(`scriptc: entry is not a file: ${input}`);

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
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(Object.keys(externalTypes).length > 0 ? { externalTypes } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(explainDynamic !== undefined ? { explainDynamic: true } : {}),
      ...(wasmFiles.length > 0 ? { wasm: wasmFiles } : {}),
      ...(nodeIslands !== undefined ? { nodeIslands } : {}),
    });
    if (!dynamicTierWarning) delete coverage.performance;
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
      if (explainIsland !== undefined) {
        process.stdout.write(
          "\n" +
            renderExplainIsland(coverage.nodeIslands, explainIsland, {
              color,
              sourceTexts,
              root: process.cwd(),
            }) +
            "\n",
        );
      }
      if (explainDynamic !== undefined && coverage.tiers !== undefined) {
        process.stdout.write(
          "\n" +
            renderExplainDynamic(coverage.tiers, {
              color,
              sourceTexts,
              root: process.cwd(),
              query: explainDynamic,
            }) +
            "\n",
        );
      }
    }
    return coveragePasses(coverage, failOn) ? 0 : 1;
  }

  if (output === null || !output.ok) throw new Error("internal output-option state");
  if (windowsSubsystem !== undefined && host.sourceTargetPlatform() !== "win32") {
    usageError(`--windows-subsystem requires a Windows executable target`);
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
      ...(backend !== undefined ? { backend } : {}),
      ...(optimization !== undefined ? { optimization } : {}),
      ...(values.strip ? { strip: true } : {}),
      ...(values.static ? { staticLink: true } : {}),
      ...(windowsSubsystem !== undefined ? { windowsSubsystem } : {}),
      ...(values["detached-exit"] ? { detachedExit: true } : {}),
      ...(values["stdout-buffering"] ? { stdoutBuffering: true } : {}),
      ...(values.libnode !== undefined
        ? {
            libnode:
              values.libnode === "beside" || values.libnode.startsWith("$ORIGIN/")
                ? values.libnode
                : resolve(values.libnode),
          }
        : {}),
      ...(values["large-pages"] ? { largePages: true } : {}),
      ...(exceptions === "rare" ? { exceptions: "rare" as const } : {}),
      ...targetCpuField(targetCpu),
      ...(values["cpu-dispatch"] === undefined ? {} : { cpuDispatch: values["cpu-dispatch"] }),
      // The instrumented program resolves a relative pattern against its own
      // working directory; resolve it here, where the user wrote it.
      ...(values["profile-generate"] === undefined
        ? {}
        : { profileGenerate: resolve(values["profile-generate"]) }),
      ...(values["profile-use"] === undefined
        ? {}
        : { profileUse: resolve(values["profile-use"]) }),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(nodeIslands !== undefined ? { nodeIslands } : {}),
      ...(values["shape-overlay"] === false ? { shapeOverlay: false } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(printNativeLinkInfo ? { nativeLinkInfo: true } : {}),
      ...(tier !== undefined ? { tier } : {}),
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
    const warnings = (result.warnings ?? []).filter(
      (d) => dynamicTierWarning || !isPerformanceCode(d.code),
    );
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
      // native program can behave differently from Node. The performance
      // warning names likely-hot functions that use untyped values. `run`
      // keeps stderr for the program's own output.
      const color = process.stderr.isTTY ?? false;
      const config = warnings.filter((d) => d.code === "SC8004");
      const patches = warnings.filter((d) => isTypePatchCode(d.code));
      const divergences = warnings.filter(
        (d) => !isPerformanceCode(d.code) && d.code !== "SC8004" && !isTypePatchCode(d.code),
      );
      const performance = warnings.filter((d) => isPerformanceCode(d.code));
      if (config.length > 0)
        process.stderr.write(
          renderConfigWarnings(config, result.sourceTexts ?? new Map(), { color }) + "\n",
        );
      if (patches.length > 0) {
        if (config.length > 0) process.stderr.write("\n");
        process.stderr.write(
          renderTypePatchWarnings(patches, result.sourceTexts ?? new Map(), { color }) + "\n",
        );
      }
      if (divergences.length > 0) {
        if (config.length > 0 || patches.length > 0) process.stderr.write("\n");
        process.stderr.write(
          renderWarnings(divergences, result.sourceTexts ?? new Map(), { color }) + "\n",
        );
      }
      if (performance.length > 0) {
        if (divergences.length > 0 || config.length > 0 || patches.length > 0)
          process.stderr.write("\n");
        process.stderr.write(renderPerformanceWarnings(performance) + "\n");
      }
    }
    if (result.artifact.kind === "exe") {
      // How the profile matched the program's functions; `run` keeps stderr
      // for the program's own output.
      const profileUse = values["profile-use"];
      if (
        command === "build" &&
        profileUse !== undefined &&
        result.artifact.profileMatch !== undefined
      )
        process.stderr.write(renderNativeProfileMatch(profileUse, result.artifact.profileMatch));
      if (!values["keep-llvm"]) rmSync(result.artifact.translationUnitPath, { force: true });
    } else if (result.artifact.kind === "obj") {
      nativeLinkInfo = result.artifact.nativeLinkInfo;
    }
    return result.artifact.path;
  };

  const binary = await build();

  if (command === "run") {
    return host.run(binary, programArgs);
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

/** Whether any Node island flag is present (they belong to build, run and
 * coverage). */
function hasNodeIslandFlags(values: ReturnType<typeof parseCli>["values"]): boolean {
  return (
    values["node-islands"] !== undefined ||
    (values["node-island"] ?? []).length > 0 ||
    (values.native ?? []).length > 0 ||
    values.node !== undefined ||
    values["explain-island"] !== undefined ||
    values["strict-user-js"]
  );
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
