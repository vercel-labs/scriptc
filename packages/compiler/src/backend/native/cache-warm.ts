import type { NativeOptimization } from "../optimization.js";
import { isMobileTarget, mobileLibraryTarget } from "../target-platform.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { cacheRootDir, ensurePrivateCacheRoot, fileExists, pruneCache } from "../build-cache.js";
import { type CcDriver, targetPlatform, resolveCc } from "./driver.js";
import { clearCcCaches } from "./runtime-objects.js";
import { compileCInternal } from "./executable.js";

export type NativeCacheWarmProfile = "runtime" | "tls" | "dynamic";

export interface WarmNativeCachesOptions {
  /** Native object posture to seed. Defaults to the shipped release/-O2 lane. */
  optimization?: NativeOptimization;
  /** Seed ASan + RC-audit objects instead of the ordinary lane. */
  sanitize?: boolean;
  /** Feature families to seed. Defaults to every expensive native family. */
  profiles?: readonly NativeCacheWarmProfile[];
}

export interface WarmNativeCachesResult {
  cacheRoot: string;
  profiles: { profile: NativeCacheWarmProfile; elapsedMs: number }[];
}

export function supportedNativeCacheWarmProfiles(
  driver: CcDriver,
): readonly NativeCacheWarmProfile[] {
  if (isMobileTarget(driver.target) || targetPlatform(driver) === "wasi") return [];
  return ["runtime", "tls", "dynamic"];
}

/** Populate expensive native prerequisites against the current compiler,
 * target, SDK, and environment. The resulting entries use the exact same
 * identities and validators as ordinary builds; this merely pays their cost
 * before a developer's first program asks for them. Synthetic link products
 * are discarded and never enter the complete-executable cache. */
export async function warmNativeCaches(
  options: WarmNativeCachesOptions = {},
): Promise<WarmNativeCachesResult> {
  clearCcCaches();
  const cacheRoot = cacheRootDir();
  if (cacheRoot === null) {
    throw new Error(
      "the native build cache is disabled (unset SCRIPTC_NO_CACHE and use a non-empty SCRIPTC_CACHE_DIR)",
    );
  }
  await ensurePrivateCacheRoot(cacheRoot, process.env["SCRIPTC_CACHE_DIR"] === undefined);
  const known = new Set<NativeCacheWarmProfile>(["runtime", "tls", "dynamic"]);
  for (const profile of options.profiles ?? []) {
    if (!known.has(profile)) throw new Error(`unknown native cache warm profile '${profile}'`);
  }
  if (options.profiles?.length === 0) return { cacheRoot, profiles: [] };
  const mobileTarget = mobileLibraryTarget();
  if (mobileTarget !== null) {
    throw new Error(
      `native cache warming targets executable builds and is unsupported for SCRIPTC_TARGET=${mobileTarget}`,
    );
  }
  const driver = resolveCc();
  const supported = supportedNativeCacheWarmProfiles(driver);
  if (supported.length === 0) {
    throw new Error(
      `native cache warming targets persistently cached native executables and is unsupported for SCRIPTC_TARGET=${driver.target}`,
    );
  }
  const profiles = [...new Set(options.profiles ?? supported)];
  for (const profile of profiles) {
    if (!supported.includes(profile)) {
      throw new Error(
        `native cache warm profile '${profile}' is unsupported for SCRIPTC_TARGET=${driver.target}`,
      );
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "scriptc-cache-warm-"));
  const cPath = join(workDir, "warm.c");
  await writeFile(cPath, "int main(void) { return 0; }\n");
  const protectedPaths = new Set<string>();
  try {
    const results = await Promise.all(
      profiles.map(async (profile) => {
        const started = performance.now();
        await compileCInternal(
          {
            cPath,
            outPath: join(workDir, process.platform === "win32" ? `${profile}.exe` : profile),
            cacheIdentity: "scriptc-native-cache-warm-v1",
            optimization: options.optimization ?? "release",
            sanitize: options.sanitize ?? false,
            ...(profile === "tls" ? { fetch: true } : {}),
            ...(profile === "dynamic" ? { dynamic: true } : {}),
          },
          true,
          protectedPaths,
        );
        return {
          profile,
          elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        };
      }),
    );
    await pruneCache(cacheRoot).catch(() => undefined);
    if (!(await Promise.all([...protectedPaths].map(fileExists))).every(Boolean)) {
      throw new Error(
        `SCRIPTC_CACHE_MAX_MB is too small to retain the requested native cache warm profiles (${profiles.join(", ")})`,
      );
    }
    return { cacheRoot, profiles: results };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
