/** Platform-linker invocation for a previously created native link plan.
 *
 * No source file is accepted here.  That makes it mechanically impossible
 * for the helper/runtime-pack executable route to compile generated or
 * runtime C as part of linking.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { delimiter } from "node:path";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CcCompileError,
  nativeArtifactDependenciesStillMatch,
  parseLinkTraceFiles,
  subprocessFailureDetail,
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
  type NativeArtifactDependency,
} from "./native-toolchain.js";
import { RuntimePackError, stageRuntimePackArtifacts } from "./runtime-pack.js";
import type { NativeLinkPlan } from "./link-plan.js";

const execFileAsync = promisify(execFile);

/** The linker (or linker driver) is independent from SCRIPTC_CC.  A plain
 * `clang` is the initial macOS driver because it locates the selected SDK and
 * CRT inputs; it receives only objects and archives on this route. */
export function resolvePlatformLinker(env: NodeJS.ProcessEnv = process.env): string {
  return env["SCRIPTC_LINKER"] || "clang";
}

/** Exact executable selected for a linker spelling.  The object-only route
 * must still invalidate an early executable when a new `clang` appears ahead
 * of an unchanged PATH entry; relying on the string "clang" would restore a
 * binary past a wrapper that injects link inputs. */
function platformLinkerIdentity(
  env: NodeJS.ProcessEnv,
  linker: string = resolvePlatformLinker(env),
): string {
  const hasSeparator = linker.includes("/") || linker.includes("\\");
  const pathEntries = hasSeparator
    ? [""]
    : (env["PATH"] ?? "/usr/bin:/bin").split(delimiter);
  const extensions = process.platform === "win32" && !/\.[^/\\]+$/.test(linker)
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of pathEntries) {
    const base = hasSeparator
      ? (isAbsolute(linker) ? linker : resolve(linker))
      : join(entry === "" ? process.cwd() : entry, linker);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        if (!existsSync(candidate)) continue;
        const canonical = realpathSync(candidate);
        const info = statSync(canonical);
        if (!info.isFile()) continue;
        return [canonical, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join("\0");
      } catch {
        // Keep searching PATH exactly as process spawning does.
      }
    }
  }
  return `<unresolved:${linker}>`;
}

/** Cache-route identity for an object-only platform-link invocation.  The
 * complete executable cache additionally records and revalidates the
 * linker's resolved SDK/CRT inputs before it restores an executable.  This
 * deliberately performs no synthetic C compilation: the linker receives
 * only the helper-produced program object and runtime-pack artifacts. */
export async function executableLinkerEnvironmentFingerprint(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const linker = resolvePlatformLinker(env);
  const linkerIdentity = platformLinkerIdentity(env);
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
    effectiveDriverIdentity = env["SCRIPTC_LINKER"] === undefined
      ? `<unavailable:${linker}:${randomUUID()}>`
      : `<unavailable:${linker}>`;
  }
  const hash = createHash("sha256")
    .update("executable-linker-environment-v2\0")
    .update(toolchainEnvironmentFingerprint(env)).update("\0")
    .update(linkerIdentity).update("\0")
    .update(effectiveDriverIdentity).update("\0");
  for (const name of ["PATH", "SCRIPTC_FETCH_CURL", "SCRIPTC_TEST_RUNTIME_SRC_DIR"] as const) {
    const value = env[name];
    hash.update(name).update(value === undefined ? "\0unset\0" : "\0set\0").update(value ?? "").update("\0");
  }
  return hash.digest("hex");
}

/** Whether the object-only linker route can publish a whole executable cache
 * entry. The current proof machinery trusts only the direct default driver;
 * a caller-selected SCRIPTC_LINKER may be a wrapper with hidden inputs. */
export function platformLinkerSupportsPersistentCache(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // The Apple system shim is a stable front door to the active SDK/linker;
  // linkNativeExecutable snapshots the selected transitive inputs before it
  // publishes the final cache entry. A PATH wrapper is intentionally opaque.
  return env["SCRIPTC_LINKER"] === undefined &&
    toolchainEnvironmentCachePolicy(env).completeArtifacts &&
    platformLinkerIdentity(env).startsWith("/usr/bin/clang\0");
}

async function snapshotDependencies(paths: readonly string[]): Promise<NativeArtifactDependency[]> {
  const { lstat, realpath } = await import("node:fs/promises");
  return Promise.all([...new Set(paths.map((path) => resolve(path)))].sort().map(async (path) => {
    const info = await lstat(path);
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "symlink";
    const dependency: NativeArtifactDependency = {
      path,
      kind,
      dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size),
      mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs),
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
  }));
}

/** Resolve platform SDK/CRT inputs from the actual object-only link line.
 *
 * This intentionally avoids native-toolchain's C-driver probe: the program
 * object and staged runtime pack already give the linker everything it needs
 * for a faithful dry/trace link.  Besides keeping the Phase 5 boundary
 * honest, this observes driver options injected only at link time. */
async function objectLinkerDependencyPaths(
  linker: string,
  args: readonly string[],
  cwd: string,
  excludedRoots: readonly string[],
): Promise<string[]> {
  const [reportedLinker, dryRun, trace] = await Promise.all([
    execFileAsync(linker, ["-print-prog-name=ld"], { cwd, maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync(linker, [...args, "-###"], { cwd, maxBuffer: 32 * 1024 * 1024 }),
    execFileAsync(linker, [...args, "-Wl,-t"], { cwd, maxBuffer: 32 * 1024 * 1024 }),
  ]);
  const paths = new Set<string>();
  const add = async (candidate: string): Promise<void> => {
    const path = resolve(cwd, candidate.trim());
    if (path === "") return;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) paths.add(path);
  };
  await add(reportedLinker.stdout.trim());
  for (const path of await parseLinkTraceFiles(
    `${dryRun.stdout}\n${dryRun.stderr}`,
    cwd,
    cwd,
    true,
  )) paths.add(path);
  for (const path of await parseLinkTraceFiles(
    `${trace.stdout}\n${trace.stderr}`,
    cwd,
    cwd,
  )) paths.add(path);
  const normalizedRoots = excludedRoots.map((root) => resolve(root));
  return [...paths].filter((path) => !normalizedRoots.some((root) =>
    path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
  )).sort();
}

export async function linkNativeExecutable(
  plan: NativeLinkPlan,
  options: {
    linker?: string;
    onArtifactReady?: (artifact: { dependencies: NativeArtifactDependency[] }) => Promise<void>;
  } = {},
): Promise<void> {
  const linker = options.linker ?? resolvePlatformLinker();
  // ld64 derives an ad-hoc signature identifier from the output basename.
  // Keep that basename caller-visible while a private sibling directory gives
  // the link its own inode and preserves an atomic same-filesystem install.
  const privateOutRoot = await mkdtemp(
    join(dirname(plan.outputPath), ".scriptc-runtime-pack-link-"),
  );
  const privateOut = join(privateOutRoot, basename(plan.outputPath));
  let stagedRoot: string | null = null;
  try {
    const staged = await stageRuntimePackArtifacts(plan.runtimePack);
    stagedRoot = staged.root;
    const args = [
      ...plan.driverFlags,
      ...plan.inputs.map((input) => staged.replacements.get(input) ?? input),
      ...plan.systemLibraries.map((name) => `-l${name}`),
      "-o", privateOut,
    ];
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
    const preLinkDependencies = options.onArtifactReady === undefined ||
        !(await nativeArtifactDependenciesStillMatch(inheritedDependencies).catch(() => false))
      ? null
      : await objectLinkerDependencyPaths(linker, args, privateOutRoot, [
          privateOutRoot,
          staged.root,
          ...plan.inputs,
        ])
        .then(async (toolchain) => [
          ...inheritedDependencies,
          ...await snapshotDependencies([...toolchain, ...additionalDependencyPaths]),
        ])
        .catch(() => null);
    await execFileAsync(linker, args);
    const output = await stat(privateOut);
    if (!output.isFile() || output.size === 0) throw new Error("linker produced no executable");
    await rename(privateOut, plan.outputPath).catch(async () => {
      await rm(plan.outputPath, { force: true });
      await rename(privateOut, plan.outputPath);
    });
    if (
      options.onArtifactReady !== undefined && preLinkDependencies !== null &&
      await nativeArtifactDependenciesStillMatch(preLinkDependencies).catch(() => false)
    ) {
      await options.onArtifactReady({ dependencies: preLinkDependencies }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CcCompileError || error instanceof RuntimePackError) throw error;
    const detail = subprocessFailureDetail(error);
    throw new CcCompileError(
      linker,
      detail,
      `${linker} failed linking ${basename(plan.outputPath)} from the precompiled runtime pack.\n${detail}`,
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
