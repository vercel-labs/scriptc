/** Profile-guided optimization for helper-compiled executables.
 *
 * An instrumented build (`--profile-generate`) counts how often each branch
 * and call runs and writes the counts when the program exits. `scriptc
 * merge-profiles` turns those raw profiles into one indexed profile, and an
 * optimized build (`--profile-use`) lays out, inlines, and splits code by it.
 * The helper applies both in the pre-link pipeline of every partition.
 *
 * A second phase records context-sensitive counts: a build with both flags
 * is optimized by the first profile and instrumented again after inlining,
 * and merging its raw profiles into the first profile adds the counts of the
 * inlined code. A profile with those counts also orders each function's
 * blocks by them and moves cold blocks to separate sections.
 *
 * A function whose control flow changed since the profile was collected
 * takes none of its counts. A block-count file beside the profile
 * (profileBlocksPath) describes each function by its blocks' labels instead,
 * and annotates those functions: blocks that keep their place take their
 * recorded counts, and the counts of the others follow from flow
 * conservation. A `--profile-use` build writes that file for the functions
 * its profile annotates when SCRIPTC_RECORD_PROFILE_BLOCKS names its path.
 */
import type { NativeOptimization } from "./optimization.js";

export interface NativeProfileOptions {
  /** Raw profile path pattern written by the instrumented executable. With
   * `use`, the instrumentation runs after inlining and records
   * context-sensitive counts. */
  generate?: string;
  /** Indexed profile, the digest of its bytes (which key every cache),
   * whether it holds context-sensitive counts, and its block-count file
   * with the digest of its bytes when there is one. */
  use?: {
    path: string;
    digest: string;
    contextSensitive: boolean;
    blocks?: { path: string; digest: string };
  };
  /** With `use`: the path the build writes the block counts of the
   * functions the profile annotates to. Such a build reuses no cached
   * artifacts. */
  recordBlocks?: string;
}

/** The environment variable that names the block-count file a
 * `--profile-use` build writes. */
export const RECORD_PROFILE_BLOCKS_ENV = "SCRIPTC_RECORD_PROFILE_BLOCKS";

/** The block-count file beside a profile: its path with `.blocks` in place
 * of a `.profdata` extension, or with `.blocks` appended. */
export function profileBlocksPath(profilePath: string): string {
  return profilePath.endsWith(".profdata")
    ? `${profilePath.slice(0, -".profdata".length)}.blocks`
    : `${profilePath}.blocks`;
}

/** The block-count file a `--profile-use` build writes, from the
 * environment, or undefined. */
export function recordProfileBlocksPath(
  env: Record<string, string | undefined>,
): string | undefined {
  const path = env[RECORD_PROFILE_BLOCKS_ENV];
  return path === undefined || path === "" ? undefined : path;
}

/** Whether an indexed profile holds context-sensitive counts: the header's
 * version word carries LLVM's VARIANT_MASK_CSIR_PROF flag, bit 57, which is
 * bit 1 of its last byte. */
export function profileHasContextCounts(bytes: Uint8Array): boolean {
  const magic = [0xff, 0x6c, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x81];
  if (bytes.length < 16 || magic.some((byte, index) => bytes[index] !== byte)) return false;
  return (bytes[15]! & 0x02) !== 0;
}

/** Why a request cannot use profiles, or null when it can. */
export function nativeProfileRefusal(options: {
  profileGenerate?: string;
  profileUse?: string;
  outputKind: string;
  optimization: NativeOptimization;
  sanitize: boolean;
  platform: string;
}): string | null {
  const generate = options.profileGenerate !== undefined;
  const use = options.profileUse !== undefined;
  if (!generate && !use) return null;
  const flag = generate ? "--profile-generate" : "--profile-use";
  if (options.outputKind !== "exe") return `${flag} is only supported for executable output`;
  if (options.sanitize) return `${flag} cannot be combined with --sanitize`;
  if (options.optimization === "dev")
    return `${flag} needs an optimized build (--optimization=release or speed)`;
  if (generate && options.platform !== "linux")
    return "--profile-generate is only supported for Linux executables";
  return null;
}

export function nativeProfileHelperArgs(profile: NativeProfileOptions | undefined): string[] {
  return [
    ...(profile?.generate === undefined ? [] : ["--profile-generate", profile.generate]),
    ...(profile?.use === undefined ? [] : ["--profile-use", profile.use.path]),
    ...(profile?.use?.blocks === undefined ? [] : ["--profile-blocks", profile.use.blocks.path]),
    ...(profile?.use === undefined || profile.recordBlocks === undefined
      ? []
      : ["--record-profile-blocks", profile.recordBlocks]),
  ];
}

/** How an optimized build's profile matched the program's functions, as the
 * helper reports it: functions that took the profile's counts, functions
 * whose control flow changed since the profile was collected, functions the
 * profile has no record of (new, or never run while it was collected),
 * mismatched functions that the block-count file annotated (never more
 * than the mismatched ones), and partitions reused from the cache without
 * their counts. Helpers that weigh the match also report the profile's
 * counters on the annotated and on the mismatched functions. */
export interface NativeProfileMatch {
  annotated: number;
  mismatched: number;
  missing: number;
  recovered: number;
  unknownPartitions: number;
  annotatedCounts?: number;
  mismatchedCounts?: number;
}

/** The profile match in a successful helper emit's output, or null when the
 * helper reports none (a helper that predates the report). */
export function parseNativeProfileMatch(stdout: string): NativeProfileMatch | null {
  for (const line of stdout.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const profile = (parsed as { profile?: Record<string, unknown> } | null)?.profile;
    if (typeof profile !== "object" || profile === null) continue;
    const count = (key: string): number | null => {
      const value = profile[key];
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
    };
    const annotated = count("annotated");
    const mismatched = count("mismatched");
    const missing = count("missing");
    // A helper that predates block-count files reports no recovered count.
    const recovered = profile["recovered"] === undefined ? 0 : count("recovered");
    const unknownPartitions = count("unknown_partitions");
    if (
      annotated === null ||
      mismatched === null ||
      missing === null ||
      recovered === null ||
      unknownPartitions === null
    )
      continue;
    const annotatedCounts = count("annotated_counts");
    const mismatchedCounts = count("mismatched_counts");
    return {
      annotated,
      mismatched,
      missing,
      recovered,
      unknownPartitions,
      ...(annotatedCounts === null || mismatchedCounts === null
        ? {}
        : { annotatedCounts, mismatchedCounts }),
    };
  }
  return null;
}

/** The share of the functions a profile describes whose control flow changed
 * since it was collected, above which `scriptc build` warns that the profile
 * is stale. A freshly collected profile has none. */
export const STALE_PROFILE_SHARE = 0.1;

/** `scriptc build --profile-use`'s report on stderr: one line with the match,
 * a line with the functions the block-count file annotated when there are
 * any, and a warning line when more than STALE_PROFILE_SHARE of the
 * functions the profile describes changed since it was collected and took
 * no counts. */
export function renderNativeProfileMatch(
  profile: string,
  match: NativeProfileMatch,
  blocks: string = profileBlocksPath(profile),
): string {
  const unknown =
    match.unknownPartitions === 0
      ? ""
      : `, ${match.unknownPartitions} partition${match.unknownPartitions === 1 ? "" : "s"} without counts`;
  const lines = [
    `scriptc: profile ${profile}: ${match.annotated} functions annotated, ${match.mismatched} mismatched, ${match.missing} without a record${unknown}`,
  ];
  if (match.recovered > 0)
    lines.push(
      `scriptc: profile ${profile}: ${match.recovered} function${match.recovered === 1 ? "" : "s"} without profile counts annotated from ${blocks}`,
    );
  const described = match.annotated + match.mismatched;
  const uncounted = Math.max(0, match.mismatched - match.recovered);
  if (described > 0 && uncounted / described > STALE_PROFILE_SHARE) {
    const percent = ((uncounted / described) * 100).toFixed(1);
    lines.push(
      `scriptc: warning: ${uncounted} of the ${described} functions ${profile} describes (${percent}%) changed since it was collected and are optimized without their counts; collect the profile again`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Cache-key part; empty without a profile so other keys are unchanged. */
export function nativeProfileKey(profile: NativeProfileOptions | undefined): string {
  return [
    ...(profile?.generate === undefined ? [] : [`profile-generate:${profile.generate}`]),
    ...(profile?.use === undefined ? [] : [`profile-use:${profile.use.digest}`]),
    ...(profile?.use?.blocks === undefined ? [] : [`profile-blocks:${profile.use.blocks.digest}`]),
  ].join("\0");
}

/** Whether a build lays out its code by context-sensitive counts: it uses a
 * profile that has them, and records none. */
export function nativeProfileLayout(profile: NativeProfileOptions | undefined): boolean {
  return profile?.use?.contextSensitive === true && profile.generate === undefined;
}

/** The instrumented link adds the compiler driver's profile runtime. */
export function profileGenerateLinkerArgs(generate: boolean): string[] {
  return generate ? ["-fprofile-generate"] : [];
}

/** A link that lays out code by a profile keeps the hot, unlikely and split
 * sections the helper writes apart, so each kind of code sits together. Zig,
 * which links cross-compiled and glibc-versioned Linux targets, rejects the
 * flag, so those links leave it out. */
export function profileLayoutLinkerArgs(
  target: { platform: string; defaultLinker: string },
  layout: boolean,
): string[] {
  return layout && target.platform === "linux" && target.defaultLinker !== "zig"
    ? ["-Wl,-z,keep-text-section-prefix"]
    : [];
}
