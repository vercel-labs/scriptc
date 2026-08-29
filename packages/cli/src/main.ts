import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze, buildTargetPlatform, compile, compileExternalC, compileLibrary, isExactExternalTypeSpecifier, renderDiagnostics, renderCoverage, resolveProvenanceSources, setProvenanceSources, warmNativeCaches, type CoverageInput, type NativeCacheWarmProfile } from "@scriptc/compiler";
import { LEGACY_C_EXECUTABLE_WARNING, shouldWarnLegacyCExecutable } from "./legacy-c-warning.js";
import { resolveOutputOptions } from "./output-options.js";
import { selectOutputPaths } from "./paths.js";
import { CLI_OPTIONS, USAGE } from "./usage.js";

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

/** The coverage report's per-package --npm-static rows (structural view:
 * the compiler owns the nominal type). */
type NpmStaticStatuses = NonNullable<CoverageInput["npmStatic"]>;

interface AutoExpansion {
  /** The opt-in set the real run receives: the transitive closure of the
   * auto-detected packages, or plain "auto" when nothing transitive
   * appeared (the compiler's own auto posture, byte-identical to a
   * single-detection run). */
  npmStatic: string[] | "auto";
  /** Fallback rows the growth probes recorded but the final EXPLICIT-list
   * run cannot re-derive (explicit lists skip auto detection, so a
   * package auto refused — minified dist, no .d.ts — would lose its
   * coverage row). The coverage command splices these back in. */
  fallbacks: NpmStaticStatuses;
}

/* --npm-static auto's transitive closure, CLI-side.
 *
 * The compiler's auto detection reads only the program's own files, so an
 * opted-in package's own bare deps never got judged: `express` joined
 * statically while its `require("qs")` edges kept serving from the island
 * (or blocking a flagless build). The library lane closes this fixpoint
 * inside the compiler (the growing graph's edges are re-judged every
 * reload); the executable lane gets the same closure HERE — the CLI grows
 * the set from the opted-in packages' shipped-JS edges and lets the
 * compiler judge every round, so the eligibility bar, the graceful
 * per-package fallbacks, and the inferred-surface probing all stay the
 * compiler's, never re-implemented here.
 *
 * Bounded like the lib lane: every round settles at least one new package
 * for good, and the round cap only guards against pathological graphs. */
const AUTO_EXPANSION_ROUNDS = 8;
/** Shipped-JS scan bounds: entry-reachable files only, and a package that
 * ships more than this much reachable JS is scanned no less partially than
 * the island it would otherwise serve — the candidates found so far still
 * join. */
const AUTO_SCAN_FILE_LIMIT = 64;
const AUTO_SCAN_BYTES_LIMIT = 1 << 20;
const SHIPPED_JS = /\.(?:js|mjs|cjs)$/;
/** require("x") / import("x") / import x from "x" / export x from "x" —
 * the textual edge shapes shipped CJS/ESM declares. Over-approximation is
 * fine: every candidate is resolved on disk and then judged by the
 * compiler's own eligibility bar. */
const MODULE_SPECIFIER = /(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s+)["']([^"']+)["']/g;

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** node_modules walk-up for a bare specifier's package directory, probed
 * from each base in turn (the importing file's dir first, then the
 * package's own realpath — pnpm farms deps next to the real location, not
 * the symlink). Unresolvable candidates are skipped: an explicit opt-in of
 * a missing package is a different diagnostic than an island edge. */
function resolvePackageDir(name: string, bases: readonly string[]): string | null {
  for (const base of bases) {
    for (let dir = base; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (isDirectory(candidate)) return realpathSafe(candidate);
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

/** The bare package name of a module specifier ("qs", "@scope/pkg",
 * subpaths resolved to their package) — null for non-bare shapes. */
function packageNameOfSpecifier(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (parts[0] === "") return null;
  if (parts[0]!.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0]!;
}

/** Entry-reachable shipped JS of a package: the manifest's main/module/
 * exports answers plus everything their RELATIVE requires reach, staying
 * inside the package (nested node_modules belong to the nested package)
 * and inside the scan bounds. */
function shippedFilesOf(pkgDir: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (path: string): void => {
    const norm = path.split("\\").join("/");
    if (seen.has(norm) || files.length >= AUTO_SCAN_FILE_LIMIT) return;
    seen.add(norm);
    files.push(path);
    queue.push(path);
  };
  const resolveRelative = (fromFile: string, spec: string): string | null => {
    const base = join(dirname(fromFile), spec);
    const stem = base.replace(/\.js$/, "");
    for (const candidate of [base, `${stem}.js`, `${stem}.cjs`, `${stem}.mjs`, join(stem, "index.js"), join(stem, "index.cjs"), join(stem, "index.mjs")]) {
      if (!candidate.startsWith(pkgDir)) continue;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* probe on */
      }
    }
    return null;
  };
  let entryAnswers: string[] = ["index.js"];
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };
    const flat: string[] = [];
    const walkExports = (value: unknown): void => {
      if (typeof value === "string") flat.push(value);
      else if (value !== null && typeof value === "object") for (const v of Object.values(value)) walkExports(v);
    };
    walkExports(manifest.exports);
    entryAnswers = [...(manifest.main !== undefined ? [manifest.main] : []), ...(manifest.module !== undefined ? [manifest.module] : []), ...flat, "index.js"];
  } catch {
    /* no readable manifest: the index.js default stands */
  }
  for (const answer of entryAnswers) {
    if (!SHIPPED_JS.test(answer)) continue;
    const entry = resolveRelative(join(pkgDir, "package.json"), answer);
    if (entry !== null) push(entry);
  }
  let readBytes = 0;
  for (let head = 0; head < queue.length; head++) {
    const file = queue[head]!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    readBytes += source.length;
    if (readBytes > AUTO_SCAN_BYTES_LIMIT) break;
    for (const m of source.matchAll(/(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s+)["'](\.[^"']+)["']/g)) {
      const target = resolveRelative(file, m[1]!);
      if (target !== null) push(target);
    }
  }
  return files;
}

/** The bare npm packages a static package's shipped JS declares as edges
 * (its "dependencies" as the code actually spells them) that resolve on
 * disk from the package's own realm. */
function bareDependencyEdges(pkg: string, entryDir: string): string[] {
  const pkgDir = resolvePackageDir(pkg, [entryDir]);
  if (pkgDir === null) return [];
  const realPkgDir = realpathSafe(pkgDir);
  const edges = new Set<string>();
  for (const file of shippedFilesOf(pkgDir)) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of source.matchAll(MODULE_SPECIFIER)) {
      const name = packageNameOfSpecifier(m[1]!);
      if (name === null || name === pkg || edges.has(name)) continue;
      if (resolvePackageDir(name, [dirname(file), realPkgDir, entryDir]) !== null) edges.add(name);
    }
  }
  return [...edges];
}

async function expandNpmStaticAuto(
  input: string,
  base: { dynamic?: boolean; ffiProfilePath?: string; externalTypes?: Record<string, string> },
): Promise<AutoExpansion> {
  try {
    const probe = (npmStatic: string[] | "auto"): ReturnType<typeof analyze> =>
      analyze(input, { ...base, npmStatic });
    const first = probe("auto");
    const initial = first.coverage.npmStatic ?? [];
    const statics = initial.filter((s) => s.status === "static").map((s) => s.package);
    if (statics.length === 0) return { npmStatic: "auto", fallbacks: [] };
    const entryDir = dirname(input);
    const opted = new Set(statics);
    const refused = new Set<string>();
    const fallbacks = new Map<string, NpmStaticStatuses[number]>();
    for (const s of initial) if (s.status === "fallback") { refused.add(s.package); fallbacks.set(s.package, s); }
    let grew = false;
    for (let round = 0; round < AUTO_EXPANSION_ROUNDS; round++) {
      const candidates = new Set<string>();
      for (const pkg of opted) {
        for (const dep of bareDependencyEdges(pkg, entryDir)) {
          if (!opted.has(dep) && !refused.has(dep)) candidates.add(dep);
        }
      }
      if (candidates.size === 0) break;
      const next = probe([...opted, ...candidates]);
      for (const s of next.coverage.npmStatic ?? []) {
        if (s.status === "static") {
          if (!opted.has(s.package)) {
            opted.add(s.package);
            grew = true;
          }
        } else {
          refused.add(s.package);
          fallbacks.set(s.package, s);
        }
      }
    }
    if (!grew) return { npmStatic: "auto", fallbacks: [] };
    return { npmStatic: [...opted], fallbacks: [...fallbacks.values()] };
  } catch {
    // The probes are a heuristic front-run of the real compile: any
    // surprise (an unreadable manifest, an analysis panic) falls back to
    // plain auto, and the real run reports whatever is true.
    return { npmStatic: "auto", fallbacks: [] };
  }
}

/** Auto-posture bookkeeping for the coverage render after a GROWN run:
 * the final analyze received an explicit list, so rows the compiler would
 * derive under auto (detection-order refusals like a minified dist) must
 * ride in from the probes, and every fallback detail names the auto
 * posture — these packages are the flag's discoveries, not user opt-ins. */
function mergeAutoFallbacks(final: NpmStaticStatuses | undefined, probes: NpmStaticStatuses): NpmStaticStatuses {
  const merged: NpmStaticStatuses = [...(final ?? [])];
  const seen = new Set(merged.map((s) => s.package));
  for (const s of probes) {
    if (seen.has(s.package)) continue;
    seen.add(s.package);
    merged.push(s);
  }
  for (const s of merged) {
    if (s.status === "fallback" && s.detail !== undefined && !s.detail.startsWith("auto: ")) {
      merged[merged.indexOf(s)] = { ...s, detail: `auto: ${s.detail}` };
    }
  }
  return merged;
}

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
  if (command === "cache") {
    if (inputArg !== "warm") fail(`unknown cache command "${inputArg ?? ""}" (supported: warm)\n\n${USAGE}`);
    if (values.lib || values.dynamic || values.backend !== undefined || values.emit !== undefined || values.print !== undefined || values["from-c"] || values.ffi !== undefined || values.profile !== undefined || (values["npm-static"] ?? []).length > 0 || values["provenance-sources"] || externalTypeArgs.length > 0 || values.out !== undefined || values["emit-ir"] || !values["keep-c"]) {
      fail(`scriptc cache warm takes only native optimization/sanitizer options and profile names\n\n${USAGE}`);
    }
    const optimization = values.optimization;
    if (optimization !== undefined && optimization !== "release" && optimization !== "dev") {
      fail(`unknown optimization "${optimization}" (supported: release, dev)\n\n${USAGE}`);
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
      result = await warmNativeCaches({
        ...(optimization === undefined ? {} : { optimization }),
        sanitize: values.sanitize,
        ...(profileArgs.length === 0
          ? {}
          : { profiles: profileArgs as NativeCacheWarmProfile[] }),
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
    if (command !== "build") fail(`--lib is a build mode (scriptc build --lib --profile <p.json>)\n\n${USAGE}`);
    const profileArg = values.profile;
    if (!profileArg) fail(`scriptc build --lib needs --profile <profile.json>\n\n${USAGE}`);
    if (inputArg) {
      fail("scriptc build --lib takes no input positional: the profile names the entry module");
    }
    if (values.dynamic || values.backend !== undefined || values.emit !== undefined || values.print !== undefined || values.optimization !== undefined || values.ffi !== undefined || (values["npm-static"] ?? []).length > 0 || externalTypeArgs.length > 0) {
      fail(
        "scriptc build --lib takes no --dynamic/--backend/--emit/--print/--optimization/--npm-static/--ffi/--external-types: the profile pins the emission and optimization, npm imports are judged automatically, outbound FFI belongs to executable builds, and external type mappings belong to coverage",
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
      process.stderr.write(renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n");
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
  if (values["emit-ir"] && (command === "build" || command === "run")) {
    process.stderr.write("scriptc: warning: --emit-ir is deprecated; use --emit=ir for IR as the primary output\n");
  }
  if (!inputArg) fail(`missing input file\n\n${USAGE}`);
  const input = resolve(inputArg);
  if (command === "coverage" && values.emit !== undefined) {
    fail(`--emit is a build/run option\n\n${USAGE}`);
  }
  if (values.print !== undefined && values.print !== "native-link-info") {
    fail(`unknown print kind "${values.print}" (supported: native-link-info)\n\n${USAGE}`);
  }
  const printNativeLinkInfo = values.print === "native-link-info";
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
  if (values.backend !== undefined && values.backend !== "c" && values.backend !== "llvm") {
    fail(`unknown backend "${values.backend}" (supported: c, llvm)\n\n${USAGE}`);
  }
  const optimization = values.optimization;
  if (optimization !== undefined && optimization !== "release" && optimization !== "dev") {
    fail(`unknown optimization "${optimization}" (supported: release, dev)\n\n${USAGE}`);
  }
  const output = command === "coverage"
    ? null
    : resolveOutputOptions(command, {
        ...(values.emit === undefined && !printNativeLinkInfo
          ? {}
          : { emit: values.emit ?? "obj" }),
        emitIr: values["emit-ir"],
        ...(values.backend === undefined ? {} : { backend: values.backend }),
        fromC: values["from-c"],
        keepC: values["keep-c"],
        sanitize: values.sanitize,
        ...(values.optimization === undefined ? {} : { optimization: values.optimization }),
        ...(values.ffi === undefined ? {} : { ffi: values.ffi }),
      });
  if (output !== null && !output.ok) fail(`${output.message}\n\n${USAGE}`);
  const backend = output?.ok ? output.backend : undefined;

  // --npm-static: repeatable and comma-splittable; the literal "auto"
  // switches to eligibility-based detection (mixing "auto" with names
  // is rejected — the shapes answer different questions).
  const npmStaticRaw = (values["npm-static"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  let autoExpansion: AutoExpansion = { npmStatic: "auto", fallbacks: [] };
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1) fail(`--npm-static auto cannot be combined with package names\n\n${USAGE}`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // Auto's transitive closure runs BEFORE the real work: the grown opt-in
  // set (express pulling its qs/send edges, and so on down) replaces the
  // bare "auto" for build/run/coverage alike, and the probes' fallback
  // notes ride along for the coverage render. Anything the compiler refused
  // along the way islands exactly as before — growth never turns a working
  // build into a failure.
  if (npmStatic === "auto") {
    autoExpansion = await expandNpmStaticAuto(input, {
      dynamic: values.dynamic,
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(Object.keys(externalTypes).length > 0 ? { externalTypes } : {}),
    });
    if (autoExpansion.npmStatic !== "auto") npmStatic = autoExpansion.npmStatic;
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
    // The grown run's probe-recorded refusals join the render: an explicit
    // opt-in list cannot re-derive them (auto detection never runs), and
    // the report must stay honest about every package the flag judged.
    const npmRows =
      autoExpansion.fallbacks.length > 0 && !coverage.preflightFailed
        ? mergeAutoFallbacks(coverage.npmStatic, autoExpansion.fallbacks)
        : coverage.npmStatic;
    const color = process.stdout.isTTY ?? false;
    const rendered =
      npmRows !== undefined && npmRows !== coverage.npmStatic
        ? renderCoverage({ ...coverage, npmStatic: npmRows }, { color, sourceTexts })
        : renderCoverage(coverage, { color, sourceTexts });
    process.stdout.write(rendered + "\n");
    return coverage.preflightFailed ? 1 : 0;
  }

  if (output === null || !output.ok) throw new Error("internal output-option state");
  const { outDir, outPath, defaultOutputPath } = selectOutputPaths(input, output.cliOutputKind, values.out);

  // SCRIPTC_CC remains a migration escape hatch for explicit C, sanitizer,
  // and comparison builds. The normal LLVM executable route is controlled by
  // SCRIPTC_LINKER, which receives objects and archives only.
  if (shouldWarnLegacyCExecutable({
    executable: output.outputKind === "exe",
    fromC: values["from-c"],
    backend: values.backend,
    sanitize: values.sanitize,
  })) {
    process.stderr.write(LEGACY_C_EXECUTABLE_WARNING);
  }

  let nativeLinkInfo: object | undefined;
  const build = async (): Promise<string> => {
    if (values["from-c"]) {
      if (ffiProfilePath !== undefined) {
        fail("--ffi is a TypeScript/JavaScript compiler feature and cannot be combined with --from-c");
      }
      await compileExternalC({
        cPath: input,
        outPath,
        sanitize: values.sanitize,
        dynamic: values.dynamic,
        ...(optimization !== undefined ? { optimization } : {}),
      });
      return outPath;
    }
    const result = await compile(input, {
      outPath,
      outDir,
      outputKind: output.outputKind,
      defaultOutputPath,
      emitIr: output.emitIr,
      sanitize: values.sanitize,
      dynamic: values.dynamic,
      ...(backend !== undefined ? { backend } : {}),
      ...(optimization !== undefined ? { optimization } : {}),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(printNativeLinkInfo ? { nativeLinkInfo: true } : {}),
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      throw new CliExit(1);
    }
    // The lane-change note: the ONLY case where silence would be dishonest
    // is the default lane quietly building through C — one stderr line
    // names the refusal. A successful LLVM build is the documented default
    // (and the kept .ll next to the binary is the durable record), and an
    // explicit --backend was the user's own choice — neither gets a line.
    if (result.artifact.kind === "exe") {
      if (result.artifact.llvmRefusal !== undefined) {
        process.stderr.write(`scriptc: backend c (llvm refused: ${result.artifact.llvmRefusal})\n`);
      }
      if (!values["keep-c"]) rmSync(result.artifact.translationUnitPath, { force: true });
    } else if (result.artifact.kind === "obj") {
      nativeLinkInfo = result.artifact.nativeLinkInfo;
    }
    return result.artifact.path;
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
  if (printNativeLinkInfo) {
    if (nativeLinkInfo === undefined) throw new Error("internal native-link-info state");
    // Keep stdout pure JSON for tooling; the ordinary artifact path is in
    // program.object inside the document.
    process.stdout.write(`${JSON.stringify(nativeLinkInfo, null, 2)}\n`);
  } else {
    process.stdout.write(`${binary}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CliExit) process.exitCode = err.code;
  else throw err;
}
