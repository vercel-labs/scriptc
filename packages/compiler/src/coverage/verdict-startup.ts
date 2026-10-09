/* The startup-sized half of the coverage verdict cache: the compiler
 * identity proof and an exact-hit replay, importable by the CLI bootstrap
 * without loading the lowering graph. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import { prepareBuildCacheRoot, resolveBuildCacheRoot } from "../backend/build-cache.js";
import { configuredTargetPlatform } from "../backend/native-toolchain.js";
import {
  compilerImplementationDependenciesStillMatch,
  compilerImplementationIdentity,
  compilerImplementationRoot,
  type CompilerImplementationDependency,
} from "../library/compiler-self-identity.js";
import { replayVerdict, fileVerdictStore } from "./verdict-cache.js";

/** The coverage cache directory under the build cache root, or null when
 * caching is disabled or unavailable. */
export async function coverageCacheDirectory(): Promise<string | null> {
  const root = await prepareBuildCacheRoot(resolveBuildCacheRoot());
  return root === null ? null : join(root, "coverage-v1");
}

/** The compiler package's content digest for coverage verdict keys. The
 * digest hashes every byte of the package; a stat-only proof of the files
 * it covered (inode, size, times) lets an unchanged installation reuse it
 * without rereading the package. `hashIfStale` false answers null instead
 * of hashing (the bootstrap then loads the full compiler). */
export async function coverageCompilerIdentity(
  directory: string,
  hashIfStale = true,
): Promise<{ digest: string } | null> {
  const proofPath = join(directory, "compiler-identity.json");
  try {
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
      root: string;
      digest: string;
      dependencies: CompilerImplementationDependency[];
    };
    if (
      proof.root === compilerImplementationRoot() &&
      /^[0-9a-f]{64}$/.test(proof.digest) &&
      (await compilerImplementationDependenciesStillMatch(proof.dependencies))
    )
      return { digest: proof.digest };
  } catch {
    // No proof yet, or an unreadable one.
  }
  if (!hashIfStale) return null;
  const identity = await compilerImplementationIdentity(true);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stage = `${proofPath}.${process.pid}.tmp`;
    await writeFile(
      stage,
      JSON.stringify({
        root: compilerImplementationRoot(),
        digest: identity.digest,
        dependencies: identity.dependencies,
      }),
    );
    await rename(stage, proofPath);
  } catch {
    // The proof is an optimization; the digest stands without it.
  }
  return { digest: identity.digest };
}

/** An exact verdict-cache hit for `scriptc coverage`, or null (the caller
 * then runs the full analysis, which also handles comment-only edits). */
export async function readCoverageVerdict(
  entry: string,
  opts: AnalyzeOptions,
): Promise<AnalyzeResult | null> {
  const directory = await coverageCacheDirectory();
  if (directory === null) return null;
  const identity = await coverageCompilerIdentity(directory, false);
  if (identity === null) return null;
  return replayVerdict(resolve(entry), opts, {
    store: fileVerdictStore(directory),
    identity: identity.digest,
    platform: configuredTargetPlatform(),
  });
}
