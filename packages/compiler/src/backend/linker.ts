/** Platform-linker invocation for a previously created native link plan.
 *
 * No source file is accepted here.  That makes it mechanically impossible
 * for the helper/runtime-pack executable route to compile generated or
 * runtime C as part of linking.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { delimiter } from "node:path";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CcCompileError, subprocessFailureDetail } from "./native/process.js";
import { NativeCodegenError } from "./native-codegen-core.js";
import {
  staticExecutableRefusal,
  staticLinkFailureNote,
  staticLinkMapArgs,
  type NativeTargetPlatform,
} from "./targets.js";
import { nativeArtifactDependenciesStillMatch } from "./native/artifact-stamps.js";
import { parseLinkTraceFiles } from "./native/linker-fingerprint.js";
import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "./toolchain-environment.js";
import { type NativeArtifactDependency } from "./native/contracts.js";
import {
  RuntimePackError,
  stageRuntimePackArtifacts,
  type RuntimePackSelection,
} from "./runtime-pack.js";
import type { NativeLinkPlan } from "./link-plan.js";
import { inputsWithoutLld, lldLinkerArgs, resolveCommandFile, resolvedLldFile } from "./lld.js";
import { hugeTextLinkerArgs, rewriteHugeTextExecutable } from "./huge-text.js";
import { systemLibraryLinkerArgs } from "./link-plan-core.js";
import {
  createDarwinDebugSymbols,
  installDarwinDebugSymbols,
  readDarwinDebugSymbols,
} from "./debug-symbols.js";

const execFileAsync = promisify(execFile);

/** The linker (or linker driver) is independent from SCRIPTC_CC.  A plain
 * `clang` is the initial macOS driver because it locates the selected SDK and
 * CRT inputs; it receives only objects and archives on this route. */
export function resolvePlatformLinker(
  env: NodeJS.ProcessEnv = process.env,
  defaultLinker: string = "clang",
): string {
  return env["SCRIPTC_LINKER"] || defaultLinker;
}

/** A linker spelling resolved the way process spawning resolves it, with the
 * file identity that distinguishes this executable from any replacement. */
interface PlatformLinkerProgram {
  /** Canonical path of the file a spawn of the spelling starts. */
  readonly path: string;
  /** Path and stat fields, joined; equal only for the same file generation. */
  readonly identity: string;
}

/** Exact executable selected for a linker spelling.  The object-only route
 * must still invalidate an early executable when a new `clang` appears ahead
 * of an unchanged PATH entry; relying on the string "clang" would restore a
 * binary it did not link. */
function resolvePlatformLinkerProgram(
  env: NodeJS.ProcessEnv,
  linker: string = resolvePlatformLinker(env),
): PlatformLinkerProgram | null {
  const hasSeparator = linker.includes("/") || linker.includes("\\");
  const pathEntries = hasSeparator ? [""] : (env["PATH"] ?? "/usr/bin:/bin").split(delimiter);
  const extensions =
    process.platform === "win32" && !/\.[^/\\]+$/.test(linker)
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const entry of pathEntries) {
    const base = hasSeparator
      ? isAbsolute(linker)
        ? linker
        : resolve(linker)
      : join(entry === "" ? process.cwd() : entry, linker);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        if (!existsSync(candidate)) continue;
        const canonical = realpathSync(candidate);
        const info = statSync(canonical);
        if (!info.isFile()) continue;
        return {
          path: canonical,
          identity: [canonical, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(
            "\0",
          ),
        };
      } catch {
        // Keep searching PATH exactly as process spawning does.
      }
    }
  }
  return null;
}

function platformLinkerIdentity(
  env: NodeJS.ProcessEnv,
  linker: string = resolvePlatformLinker(env),
): string {
  return resolvePlatformLinkerProgram(env, linker)?.identity ?? `<unresolved:${linker}>`;
}

/** Whether `path` starts with a program image rather than a script
 * interpreter line. A script's own bytes do not describe what it runs: the
 * interpreter, and whatever the script decides from its surroundings at run
 * time, stay outside the identity of the file. */
function programIsSelfContained(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const magic = Buffer.alloc(2);
    const read = readSync(descriptor, magic, 0, magic.length, 0);
    return !(read === magic.length && magic.toString("latin1") === "#!");
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** The linker program a driver runs when the link line names no `-fuse-ld`.
 * The driver reports it by name, and that name is resolved on PATH the way
 * the driver resolves it, so a new higher-priority `ld` appears in the
 * identity even though PATH and the driver file are unchanged. */
async function defaultLinkerIdentity(linker: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const reported = await execFileAsync(linker, ["-print-prog-name=ld"], {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const program = reported.stdout.trim();
    if (program === "") return "<no-default-linker>";
    return platformLinkerIdentity(env, program);
  } catch {
    return env["SCRIPTC_LINKER"] === undefined
      ? `<unavailable:${linker}:${randomUUID()}>`
      : `<unavailable:${linker}>`;
  }
}

/** Cache-route identity for an object-only platform-link invocation.  The
 * complete executable cache additionally records and revalidates the
 * linker's resolved SDK/CRT inputs before it restores an executable.  This
 * deliberately performs no synthetic C compilation: the linker receives
 * only the helper-produced program object and runtime-pack artifacts. */
export async function executableLinkerEnvironmentFingerprint(
  env: NodeJS.ProcessEnv = process.env,
  defaultLinker: string = "clang",
): Promise<string> {
  const linker = resolvePlatformLinker(env, defaultLinker);
  const linkerIdentity = platformLinkerIdentity(env, linker);
  let effectiveDriverIdentity: string;
  try {
    const selected = await execFileAsync(linker, ["-print-prog-name=clang"], {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const selectedDriver = selected.stdout.trim();
    if (selectedDriver === "") throw new Error("linker driver reported no effective clang");
    effectiveDriverIdentity = platformLinkerIdentity(env, selectedDriver);
  } catch {
    // A driver that cannot expose its effective clang may still link correctly,
    // but the trusted default cannot safely address an existing early
    // executable entry. Explicit drivers never publish complete executables,
    // so their own file identity remains a sufficient stable partial-cache key.
    effectiveDriverIdentity =
      env["SCRIPTC_LINKER"] === undefined
        ? `<unavailable:${linker}:${randomUUID()}>`
        : `<unavailable:${linker}>`;
  }
  // `-fuse-ld=lld` is chosen from the files around the driver, not from the
  // environment: an ld.lld appearing or disappearing changes the link line
  // while PATH and the driver file stay the same. Without lld the driver runs
  // the linker program it reports, and that program is resolved on PATH at
  // link time, so its own identity is recorded as well.
  const lldFile = process.platform === "linux" ? resolvedLldFile(linker, env) : null;
  const lldIdentity = process.platform === "linux" ? (lldFile ?? "<no-ld.lld>") : "<not-linux>";
  const defaultLinkerLinkIdentity =
    process.platform !== "linux"
      ? "<not-linux>"
      : lldFile !== null
        ? "<lld-selected>"
        : await defaultLinkerIdentity(linker, env);
  const hash = createHash("sha256")
    .update("executable-linker-environment-v4\0")
    .update(toolchainEnvironmentFingerprint(env))
    .update("\0")
    .update(linkerIdentity)
    .update("\0")
    .update(effectiveDriverIdentity)
    .update("\0")
    .update(lldIdentity)
    .update("\0")
    .update(defaultLinkerLinkIdentity)
    .update("\0");
  for (const name of ["PATH", "SCRIPTC_TEST_RUNTIME_SRC_DIR"] as const) {
    const value = env[name];
    hash
      .update(name)
      .update(value === undefined ? "\0unset\0" : "\0set\0")
      .update(value ?? "")
      .update("\0");
  }
  return hash.digest("hex");
}

/** Whether the object-only linker route can publish a whole executable cache
 * entry. A caller-selected SCRIPTC_LINKER may be a wrapper with hidden
 * inputs, so only the environment's own driver is considered. */
export function platformLinkerSupportsPersistentCache(
  env: NodeJS.ProcessEnv = process.env,
  target?: Pick<NativeLinkPlan["target"], "platform" | "defaultLinker">,
): boolean {
  // The final cache entry is keyed on the driver's file identity and, before
  // publication, linkNativeExecutable snapshots the driver, the linker it
  // selects and every input the link opened. On Darwin that proof is only
  // trusted for the Apple system shim, which is a stable front door to the
  // active SDK. On Linux the driver may sit in any prefix and the proof
  // covers it directly, so any resolved driver file is accepted.
  const platform = target?.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return false;
  if (env["SCRIPTC_LINKER"] !== undefined) return false;
  if (!toolchainEnvironmentCachePolicy(env).completeArtifacts) return false;
  const program = resolvePlatformLinkerProgram(env);
  if (program === null) return false;
  if (platform !== "linux") return program.path.startsWith("/usr/bin/clang");
  // A program file's own bytes describe what it runs, so its identity is a
  // cache key. A script is not: the interpreter and whatever the script
  // decides at run time (injected linker options, environment) stay outside
  // the file, so a warm build would restore an executable linked under an
  // earlier configuration. The driver and, when `-fuse-ld=lld` selects one,
  // the linker program must both be program files.
  if (!programIsSelfContained(program.path)) return false;
  const lld = resolvedLldFile(program.path, env);
  return lld === null || programIsSelfContained(lld);
}

async function snapshotDependencies(paths: readonly string[]): Promise<NativeArtifactDependency[]> {
  const { lstat, realpath } = await import("node:fs/promises");
  return Promise.all(
    [...new Set(paths.map((path) => resolve(path)))].sort().map(async (path) => {
      const info = await lstat(path);
      const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "symlink";
      const dependency: NativeArtifactDependency = {
        path,
        kind,
        dev: Number(info.dev),
        ino: Number(info.ino),
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        ctimeMs: Number(info.ctimeMs),
      };
      if (kind === "symlink") {
        const targetPath = await realpath(path);
        const target = await stat(path);
        const targetKind = target.isFile() ? "file" : target.isDirectory() ? "directory" : null;
        if (targetKind === null) throw new Error(`unsupported linker dependency: ${path}`);
        dependency.targetPath = targetPath;
        dependency.targetKind = targetKind;
        dependency.targetDev = Number(target.dev);
        dependency.targetIno = Number(target.ino);
        dependency.targetSize = Number(target.size);
        dependency.targetMtimeMs = Number(target.mtimeMs);
        dependency.targetCtimeMs = Number(target.ctimeMs);
      }
      return dependency;
    }),
  );
}

/** Resolve platform SDK/CRT inputs from the actual object-only link line.
 *
 * This intentionally avoids native compiler's C-driver probe: the program
 * object and staged runtime pack already give the linker everything it needs
 * for a faithful dry/trace link.  Besides keeping the Phase 5 boundary
 * honest, this observes driver options injected only at link time. */
async function objectLinkerDependencyPaths(
  linker: string,
  args: readonly string[],
  cwd: string,
  excludedRoots: readonly string[],
  toolPaths: readonly string[],
): Promise<string[]> {
  const [reportedLinker, dryRun, trace] = await Promise.all([
    execFileAsync(linker, ["-print-prog-name=ld"], { cwd, maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync(linker, [...args, "-###"], { cwd, maxBuffer: 32 * 1024 * 1024 }),
    execFileAsync(linker, [...args, "-Wl,-t"], { cwd, maxBuffer: 32 * 1024 * 1024 }),
  ]);
  // The driver and the linker program it selects are link inputs that neither
  // the dry run nor the trace lists.
  const paths = new Set<string>(toolPaths);
  const add = async (reported: string): Promise<void> => {
    const candidate = reported.trim();
    if (candidate === "") return;
    // A bare program name is looked up on PATH exactly as the driver did.
    const path = candidate.includes("/")
      ? resolve(cwd, candidate)
      : resolveCommandFile(candidate, process.env);
    if (path === null) return;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) paths.add(path);
  };
  await add(reportedLinker.stdout.trim());
  for (const path of await parseLinkTraceFiles(
    `${dryRun.stdout}\n${dryRun.stderr}`,
    cwd,
    cwd,
    true,
  ))
    paths.add(path);
  for (const path of await parseLinkTraceFiles(`${trace.stdout}\n${trace.stderr}`, cwd, cwd))
    paths.add(path);
  const normalizedRoots = excludedRoots.map((root) => resolve(root));
  return [...paths]
    .filter(
      (path) =>
        !normalizedRoots.some(
          (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`),
        ),
    )
    .sort();
}

/** Install the selected runtime pack's RUN-time data files (ICU's
 * icudt78l.dat) beside the executable that links them. The compiler's link
 * step is the only moment the executable's directory is known, and a data
 * file next to the binary is what the runtime looks for first.
 *
 * A file already present at the pinned size is left alone: the pack ships
 * one data set per file name, and re-copying 11.1 MiB on every build would
 * be pure cost. The copy is atomic (private temporary, then rename) so two
 * concurrent builds of the same program never observe a partial file. */
export async function installRuntimeDataFiles(
  selection: RuntimePackSelection,
  outputPath: string,
): Promise<void> {
  if (selection.dataFiles.length === 0) return;
  const outputDir = dirname(resolve(outputPath));
  for (const source of selection.dataFiles) {
    const destination = join(outputDir, basename(source));
    const sourceSize = (await stat(source)).size;
    const existing = await stat(destination).catch(() => null);
    if (existing?.isFile() && existing.size === sourceSize) continue;
    const temporary = join(
      outputDir,
      `.${basename(destination)}.scriptc-${process.pid}-${randomUUID()}`,
    );
    await copyFile(source, temporary);
    await rename(temporary, destination).catch(async () => {
      await rm(destination, { force: true });
      await rename(temporary, destination);
    });
  }
}

/** A driver the host cannot execute at all, rather than one that ran and
 * failed. `execFile` reports both as a rejected call; only a missing
 * executable says the build needs a tool this host does not have. */
function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** What to install when a target's link driver cannot be spawned. A spawn
 * failure names only the driver (`spawn zig ENOENT`), which says neither
 * what the driver is used for nor where it comes from, so the message names
 * the target's requirement and the package that provides the driver. Null
 * for any other failure, whose own output is the useful report. */
export function missingLinkDriverMessage(
  error: unknown,
  linker: string,
  platform: NativeTargetPlatform,
): string | null {
  if (!isMissingExecutable(error)) return null;
  const driver = basename(linker.replace(/\\/g, "/")).replace(/\.exe$/i, "");
  let guidance: string;
  if (driver === "zig")
    guidance =
      platform === "win32"
        ? "Windows targets link with Zig, whose releases are a single zig.exe: download it from https://ziglang.org/download and put it on PATH."
        : "This target links with Zig: download it from https://ziglang.org/download and put zig on PATH.";
  else if (driver === "clang" || driver === "clang-cl")
    guidance =
      platform === "darwin"
        ? 'macOS targets link with the clang in Apple\'s Command Line Tools: install them with "xcode-select --install".'
        : platform === "win32"
          ? "Windows targets link with clang from the LLVM release: download it from https://releases.llvm.org and put clang.exe on PATH."
          : 'Linux targets link with clang: install it with the distribution\'s package manager, for example "apt install clang".';
  else guidance = `Install ${driver} and put it on PATH.`;
  return (
    `cannot run the link driver "${linker}": the host has no ${driver} executable.\n` +
    `${guidance}\n` +
    "Set SCRIPTC_LINKER to use a different driver."
  );
}

export async function linkNativeExecutable(
  plan: NativeLinkPlan,
  options: {
    linker?: string;
    onArtifactReady?: (artifact: { dependencies: NativeArtifactDependency[] }) => Promise<void>;
  } = {},
): Promise<void> {
  const explicitLinker = options.linker ?? process.env["SCRIPTC_LINKER"];
  const linker = explicitLinker ?? plan.target.defaultLinker;
  // ld64 derives an ad-hoc signature identifier from the output basename.
  // Keep that basename caller-visible while a private sibling directory gives
  // the link its own inode and preserves an atomic same-filesystem install.
  const privateOutRoot = await mkdtemp(
    join(dirname(plan.outputPath), ".scriptc-runtime-pack-link-"),
  );
  const privateOut = join(privateOutRoot, basename(plan.outputPath));
  const linkMap = join(privateOutRoot, "link.map");
  const mapArgs = staticLinkMapArgs(plan.target, plan.staticLink === true, linkMap);
  let stagedRoot: string | null = null;
  try {
    const staged = await stageRuntimePackArtifacts(plan.runtimePack);
    stagedRoot = staged.root;
    // Linux links with lld when the default driver finds it.
    const lld = explicitLinker === undefined ? lldLinkerArgs(plan.target.platform, linker) : [];
    const zig = explicitLinker === undefined && plan.target.defaultLinker === "zig";
    const linkArgs = (withLld: boolean): string[] => {
      const inputs = plan.inputs.map((input) => staged.replacements.get(input) ?? input);
      return [
        ...(explicitLinker === undefined ? plan.target.defaultLinkerArgs : []),
        ...(withLld ? lld : []),
        ...hugeTextLinkerArgs(plan.hugeText === true, (withLld && lld.length !== 0) || zig),
        ...plan.driverFlags,
        ...mapArgs,
        ...(withLld ? inputs : inputsWithoutLld(plan.target, inputs)),
        ...systemLibraryLinkerArgs(plan.target, plan.systemLibraries),
        "-o",
        privateOut,
      ];
    };
    const args = linkArgs(lld.length !== 0);
    // The driver binary and the lld that `-fuse-ld=lld` selects are consumed
    // outside the linker's own input list, so the proof names them directly.
    const linkTools = [
      resolveCommandFile(linker, process.env),
      lld.length === 0 ? null : resolvedLldFile(linker, process.env),
    ].filter((path): path is string => path !== null);
    // The pack snapshots bracket both verification passes and private staging;
    // the program-object snapshot begins before helper emission. Snapshot the
    // remaining cache-bearing inputs before the linker consumes them, then
    // require the complete set to remain stable through publication.
    const inheritedDependencies = [
      ...plan.runtimePack.sourceDependencies,
      ...plan.programObjectDependencies,
    ];
    const inheritedDependencyPaths = new Set(
      inheritedDependencies.map((dependency) => resolve(dependency.path)),
    );
    const additionalDependencyPaths = plan.dependencyPaths.filter(
      (path) => !inheritedDependencyPaths.has(resolve(path)),
    );
    const preLinkDependencies =
      options.onArtifactReady === undefined ||
      !(await nativeArtifactDependenciesStillMatch(inheritedDependencies).catch(() => false))
        ? null
        : await objectLinkerDependencyPaths(
            linker,
            args,
            privateOutRoot,
            [privateOutRoot, staged.root, ...plan.inputs],
            linkTools,
          )
            .then(async (toolchain) => [
              ...inheritedDependencies,
              ...(await snapshotDependencies([...toolchain, ...additionalDependencyPaths])),
            ])
            .catch(() => null);
    const link = async (withLld: boolean): Promise<void> => {
      try {
        await execFileAsync(linker, linkArgs(withLld));
      } catch (error) {
        // Only the link invocation itself can report a driver the host lacks.
        // Everything after it fails with its own tool, whose name the message
        // must keep.
        const missing = missingLinkDriverMessage(error, linker, plan.target.platform);
        if (missing === null) throw error;
        throw new CcCompileError(linker, subprocessFailureDetail(error), missing);
      }
    };
    let linkedWithDefaultLinker = false;
    await link(lld.length !== 0).catch(async (error: unknown) => {
      // A failed link with lld runs again with the driver's default linker,
      // whose error (if any) is the one reported. That link line differs from
      // the one the pre-link proof describes, so the result is not published.
      // A driver the host cannot start is not retried, since the same command
      // cannot succeed.
      if (lld.length === 0 || error instanceof CcCompileError) throw error;
      await link(false);
      linkedWithDefaultLinker = true;
    });
    const output = await stat(privateOut);
    if (!output.isFile() || output.size === 0) throw new Error("linker produced no executable");
    if (plan.hugeText === true) rewriteHugeTextExecutable(privateOut);
    if (mapArgs.length !== 0) {
      const refusal = staticExecutableRefusal(plan.target, true, await readFile(linkMap, "utf8"));
      if (refusal !== null) throw new NativeCodegenError("SC3002", refusal);
    }
    if (plan.darwinDebugSymbols) {
      try {
        await createDarwinDebugSymbols(privateOut);
      } catch (error) {
        // The link succeeded and only the debug symbols are missing, so name
        // the tool that could not produce them rather than the driver.
        const detail = subprocessFailureDetail(error);
        throw new CcCompileError(
          "dsymutil",
          detail,
          `dsymutil failed to collect the debug symbols for ${basename(plan.outputPath)}:\n${detail}` +
            (isMissingExecutable(error)
              ? '\ndsymutil comes with Apple\'s developer tools: on macOS, install them with "xcode-select --install".'
              : ""),
        );
      }
      await installDarwinDebugSymbols(await readDarwinDebugSymbols(privateOut), plan.outputPath);
    }
    await rename(privateOut, plan.outputPath).catch(async () => {
      await rm(plan.outputPath, { force: true });
      await rename(privateOut, plan.outputPath);
    });
    await installRuntimeDataFiles(plan.runtimePack, plan.outputPath);
    if (plan.target.platform === "darwin" && !plan.darwinDebugSymbols) {
      await rm(`${plan.outputPath}.dSYM`, { recursive: true, force: true });
    }
    if (
      options.onArtifactReady !== undefined &&
      !linkedWithDefaultLinker &&
      preLinkDependencies !== null &&
      (await nativeArtifactDependenciesStillMatch(preLinkDependencies).catch(() => false))
    ) {
      await options.onArtifactReady({ dependencies: preLinkDependencies }).catch(() => undefined);
    }
  } catch (error) {
    if (
      error instanceof CcCompileError ||
      error instanceof RuntimePackError ||
      error instanceof NativeCodegenError
    )
      throw error;
    const detail = subprocessFailureDetail(error);
    throw new CcCompileError(
      linker,
      detail,
      `${linker} failed linking ${basename(plan.outputPath)} from the precompiled runtime pack.\n${detail}` +
        staticLinkFailureNote(plan.target, plan.staticLink === true),
    );
  } finally {
    await Promise.all([
      rm(privateOutRoot, { recursive: true, force: true }).catch(() => undefined),
      stagedRoot === null
        ? Promise.resolve()
        : rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined),
    ]);
  }
}
