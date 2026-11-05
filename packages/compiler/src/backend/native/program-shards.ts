import { basename } from "node:path";
import type { CcOptions } from "./contracts.js";
import { createHash } from "node:crypto";
import { type CcDriver, targetPlatform } from "./driver.js";
import { resolvedTool } from "./tool-identity.js";
import { rememberFingerprintDependencies } from "./dependency-files.js";

export function updateProgramShardCacheIdentity(
  hash: ReturnType<typeof createHash>,
  shards: readonly { name: string; source: () => string }[] | undefined,
  publicSymbols: readonly string[] | undefined,
  mergeIdentity: string | undefined,
): void {
  hash.update("\0program-shards\0");
  if (shards === undefined) {
    hash.update("<none>\0");
  } else {
    hash.update("<present>\0");
    for (const shard of shards) {
      hash.update(shard.name).update("\0").update(shard.source()).update("\0");
    }
  }
  hash.update("\0program-public-symbols\0");
  if (publicSymbols === undefined) {
    hash.update("<none>\0");
  } else {
    hash.update("<present>\0");
    for (const symbol of publicSymbols) hash.update(symbol).update("\0");
  }
  hash.update("\0program-shard-merge\0");
  hash.update(mergeIdentity === undefined ? "<none>\0" : `<present>\0${mergeIdentity}\0`);
}

/** Identity of the machinery that turns LLVM shard objects back into the
 * canonical program member, or null when the target cannot do so. Sharding is
 * only a build optimization: a missing host tool or unsupported object class
 * retains the ordinary single-TU compile. The identity joins every cache tier
 * that contains merged bytes; raw shard-object keys deliberately omit it. */
export async function resolveProgramShardMergeIdentity(driver: CcDriver): Promise<string | null> {
  const platform = targetPlatform(driver);
  // Mach-O merging uses the host's ld64. A Darwin target produced from a
  // non-Darwin host can still compile as one canonical Zig TU, but the host's
  // ELF/COFF linker cannot combine those objects.
  if (platform === "darwin") {
    if (process.platform !== "darwin") return null;
    const ld = await resolvedTool("ld");
    return ld === null
      ? null
      : rememberFingerprintDependencies(`program-shard-merge-darwin-v1\0${ld.cacheIdentity}`, [
          ld.canonicalPath,
        ]);
  }
  if (platform === "linux") {
    if (driver.target === null) {
      // ld -r merges; localizeElfObject demotes in process.
      const ld = await resolvedTool("ld");
      return ld === null
        ? null
        : rememberFingerprintDependencies(`program-shard-merge-linux-v2\0${ld.cacheIdentity}`, [
            ld.canonicalPath,
          ]);
    }
    const arch = driver.target.split("-", 1)[0];
    if (arch !== "x86_64" && arch !== "aarch64") return null;
    const compiler = await resolvedTool(driver.argv[0] ?? "zig");
    return compiler === null
      ? null
      : rememberFingerprintDependencies(
          `program-shard-merge-cross-elf-v1\0${arch}\0${compiler.cacheIdentity}`,
          [compiler.canonicalPath],
        );
  }
  if (platform === "win32") {
    const arch = driver.target?.split("-", 1)[0] ?? process.arch;
    return arch === "x86_64" || arch === "x64" ? `program-shard-merge-coff-v1\0${arch}` : null;
  }
  return null;
}

/** Library builds admit shards in both optimization modes; executable builds
 * admit dev LLVM, sanitized or not. Both use the same validated names, required
 * public-symbol projection, target support, and canonical-TU fallback. */
export async function selectProgramShards(
  driver: CcDriver,
  opts: Pick<CcOptions, "cPath" | "programShards" | "programPublicSymbols">,
  enabled: boolean,
): Promise<{
  programShards: NonNullable<CcOptions["programShards"]> | null;
  programPublicSymbols: CcOptions["programPublicSymbols"];
  programShardMergeIdentity: string | null;
}> {
  const names = new Set<string>();
  const valid =
    opts.programShards?.every((shard) => {
      if (
        basename(shard.name) !== shard.name ||
        !shard.name.endsWith(".ll") ||
        names.has(shard.name)
      )
        return false;
      names.add(shard.name);
      return true;
    }) === true;
  const requested =
    enabled &&
    opts.cPath.endsWith(".ll") &&
    valid &&
    opts.programShards !== undefined &&
    opts.programShards.length > 1 &&
    opts.programPublicSymbols !== undefined
      ? opts.programShards
      : null;
  const programShardMergeIdentity =
    requested === null ? null : await resolveProgramShardMergeIdentity(driver);
  const programShards = programShardMergeIdentity === null ? null : requested;
  return {
    programShards,
    programShardMergeIdentity,
    programPublicSymbols: programShards === null ? undefined : opts.programPublicSymbols,
  };
}
