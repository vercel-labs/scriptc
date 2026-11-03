import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { NativeProfileMatch } from "../backend/native-profile.js";
import { toolchainEnvironmentFingerprint } from "../backend/toolchain-environment.js";
import {
  frontendInputsStillMatch,
  validFrontendInputSnapshot,
  type FrontendInputExclusions,
  type FrontendInputSnapshot,
} from "../frontend/input-tracker.js";
import { contentDigest, fileDigest, NATIVE_STRING_BYTES, type NativeCache } from "./cache.js";
import { identity, stillMatches, validIdentity, type InputIdentity } from "./executable-cache.js";
import { nativeFileIdentity } from "./file-identity.js";
import { nativeFrontendCacheKey } from "./prepare.js";
import type { NativeToolchain } from "./toolchain.js";

/** The executable the last build of this key left in place, with the frontend
 * observations that build made and the side artifacts it wrote beside it.
 * A later build whose key matches and whose every input still matches keeps
 * all of them instead of compiling the program again: the frontend, LLVM
 * emission, object code generation and the link all compare the same inputs,
 * one level deeper than this record does. Recording the probes here (rather
 * than only in the frontend entry, whose payload carries every source text)
 * is what makes the check cost a few dozen stats. */
export interface UnchangedBuildRecord {
  schema: "scriptc.native-unchanged.v1";
  probes: FrontendInputSnapshot;
  output: InputIdentity;
  /** The kept LLVM text beside the executable. */
  translationUnit: InputIdentity;
  /** The `--emit-ir` side artifact, when the build wrote one. */
  ir: InputIdentity | null;
  /** Files the build leaves beside the executable that a run needs — an Intl
   * program's ICU data — and, on Darwin, the debug symbols of a dev build:
   * they belong to the kept output, so a kept executable needs them too. */
  beside: InputIdentity[];
  profileMatch?: NativeProfileMatch;
}

/** Highest number of input probes a record may list; a larger one is a miss,
 * which only costs a rebuild. */
const MAX_PROBES = 200_000;

function validRecord(value: unknown): value is UnchangedBuildRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<UnchangedBuildRecord>;
  return (
    record.schema === "scriptc.native-unchanged.v1" &&
    validFrontendInputSnapshot(record.probes) &&
    record.probes.probes.length <= MAX_PROBES &&
    record.output !== undefined &&
    validIdentity(record.output) &&
    record.translationUnit !== undefined &&
    validIdentity(record.translationUnit) &&
    (record.ir === null || (record.ir !== undefined && validIdentity(record.ir))) &&
    Array.isArray(record.beside) &&
    record.beside.every(validIdentity)
  );
}

/** The files a record names, for one existence and identity check. */
function recordedFiles(record: UnchangedBuildRecord): InputIdentity[] {
  return [
    record.output,
    record.translationUnit,
    ...(record.ir === null ? [] : [record.ir]),
    ...record.beside,
  ];
}

/** The identity of the program `command` runs: the linker, the dSYM tool.
 * Null when the command cannot be resolved. */
function commandIdentity(command: string): string | null {
  try {
    if (command.includes("/") || command.includes("\\"))
      return nativeFileIdentity(resolve(command));
    for (const directory of (process.env["PATH"] ?? "/usr/bin:/bin").split(delimiter)) {
      const candidate = join(directory || process.cwd(), command);
      try {
        if (statSync(candidate).isFile()) return nativeFileIdentity(candidate);
      } catch {
        /* Try the next PATH entry. */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The digest of a file whose bytes are a build input (a profile, an FFI
 * object): these are replaced in place, so an identity alone would let a
 * rewritten input pass as unchanged. Null when the file cannot be read. */
function inputDigest(path: string): string | null {
  try {
    return fileDigest(resolve(path));
  } catch {
    return null;
  }
}

export interface UnchangedBuildInputs {
  entry: string;
  options: CompileRequestOptions;
  ffi: FfiProfile | null;
  /** Digest of the FFI manifest's bytes, when the build has one. */
  ffiBytes: string | null;
  toolchain: NativeToolchain;
  output: string;
  translationUnitPath: string;
}

/** The key of an unchanged build: the frontend cache's inputs (the sources
 * and configuration themselves are proved by the recorded probes, not by the
 * key), the backend tools that produced the kept output, and the files whose
 * bytes determine the code generated — a profile the options name only by
 * path, and the objects an FFI manifest links. Null when an input cannot be
 * read, or when provenance rewriting makes the sources a build product. */
export function unchangedBuildKey(inputs: UnchangedBuildInputs): string | null {
  const { entry, options, ffi, ffiBytes, toolchain, output, translationUnitPath } = inputs;
  const frontend = nativeFrontendCacheKey(entry, options, ffi, toolchain);
  if (frontend === null) return null;
  try {
    const debug = options.optimization === "dev" && options.strip !== true;
    return contentDigest(
      JSON.stringify({
        schema: 1,
        frontend,
        output: resolve(output),
        translationUnit: resolve(translationUnitPath),
        // The tools that produced the kept output. The compiler, checker and
        // evaluator are covered by the frontend key's implementation identity.
        helper: [
          nativeFileIdentity(toolchain.helperExecutable),
          nativeFileIdentity(join(toolchain.helperPackageRoot, "package.json")),
        ],
        runtimePack: nativeFileIdentity(join(toolchain.runtimePackRoot, "package.json")),
        linker: [toolchain.linker, toolchain.linkerArgs, commandIdentity(toolchain.linker)],
        dsymutil: debug ? commandIdentity(toolchain.dsymutil) : null,
        environment: toolchainEnvironmentFingerprint(),
        profile: options.profileUse === undefined ? null : inputDigest(options.profileUse),
        libraries: ffi === null ? null : ffi.libraries.map((path) => [path, inputDigest(path)]),
        ffi: ffiBytes,
        cwd: process.cwd(),
        path: process.env["PATH"] ?? null,
      }),
    );
  } catch {
    return null;
  }
}

/** The record of an unchanged build under `key`, when the executable and the
 * files beside it are still the ones that build wrote and every input the
 * frontend observed still matches. */
export function readUnchangedBuild(
  cache: NativeCache | null,
  key: string,
  exclusions: FrontendInputExclusions,
): UnchangedBuildRecord | null {
  if (cache === null) return null;
  try {
    const bytes = cache.read("unchanged", key, NATIVE_STRING_BYTES);
    if (bytes === null) return null;
    const record: unknown = JSON.parse(bytes.toString("utf8"));
    if (!validRecord(record)) return null;
    if (!frontendInputsStillMatch(record.probes, exclusions)) return null;
    return stillMatches(recordedFiles(record)) ? record : null;
  } catch {
    return null;
  }
}

/** What a build wrote, for recordUnchangedBuild. */
export interface UnchangedBuildOutput {
  probes: FrontendInputSnapshot;
  output: string;
  translationUnitPath: string;
  irPath: string | null;
  /** Files the build leaves beside the executable (see the record's). */
  beside: readonly string[];
  profileMatch?: NativeProfileMatch;
}

/** Record a completed build, so the next build of the same key keeps its
 * output. The inputs are checked again first: a source edited while the
 * build ran is not unchanged, and the record must not claim it is. */
export function recordUnchangedBuild(
  cache: NativeCache | null,
  key: string,
  exclusions: FrontendInputExclusions,
  build: UnchangedBuildOutput,
): void {
  if (cache === null) return;
  try {
    if (!frontendInputsStillMatch(build.probes, exclusions)) return;
    const file = (path: string): InputIdentity | null => {
      try {
        return identity(path);
      } catch {
        return null;
      }
    };
    const output = file(build.output);
    const translationUnit = file(build.translationUnitPath);
    const ir = build.irPath === null ? null : file(build.irPath);
    if (output === null || translationUnit === null || (build.irPath !== null && ir === null))
      return;
    const beside: InputIdentity[] = [];
    for (const path of build.beside) {
      const installed = file(path);
      if (installed === null) return;
      beside.push(installed);
    }
    const record: UnchangedBuildRecord = {
      schema: "scriptc.native-unchanged.v1",
      probes: build.probes,
      output,
      translationUnit,
      ir,
      beside,
      ...(build.profileMatch === undefined ? {} : { profileMatch: build.profileMatch }),
    };
    cache.write("unchanged", key, JSON.stringify(record));
  } catch {
    /* An unavailable cache only prevents reuse. */
  }
}
