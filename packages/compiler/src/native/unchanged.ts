import { readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import {
  profileBlocksPath,
  recordProfileBlocksPath,
  type NativeProfileMatch,
} from "../backend/native-profile.js";
import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "../backend/toolchain-environment.js";
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
   * program's ICU data — and, on Darwin, the files of a dev build's `.dSYM`
   * bundle: they belong to the kept output, so a kept executable needs them
   * too. */
  beside: InputIdentity[];
  /** The runtime pack artifacts the build consumed — the link's objects and
   * archives, and the data it installs beside the executable. A pack edited
   * in place leaves every identity the key holds as it was. */
  packInputs: InputIdentity[];
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
    record.beside.every(validIdentity) &&
    Array.isArray(record.packInputs) &&
    record.packInputs.every(validIdentity)
  );
}

/** The files a record names, for one existence and identity check. */
function recordedFiles(record: UnchangedBuildRecord): InputIdentity[] {
  return [
    record.output,
    record.translationUnit,
    ...(record.ir === null ? [] : [record.ir]),
    ...record.beside,
    ...record.packInputs,
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

/** The identity of a file the build may not have: null when it does not
 * exist, so that creating it changes the key. */
function optionalIdentity(path: string): string | null {
  try {
    return nativeFileIdentity(path);
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
 * path, with the block-count file beside it, and the objects an FFI manifest
 * links. Null when an input cannot be read, when provenance rewriting makes
 * the sources a build product, when the build writes a block-count file (that
 * file comes from the helper, and a kept output would leave it unwritten),
 * when the manifest names a system library or a framework whose file the
 * linker resolves, when the toolchain supplies linker arguments (which the
 * linker resolves against its own search paths), when `SCRIPTC_LINKER` or
 * `SCRIPTC_LLVM_HELPER` selects a wrapper that may bring inputs of its own,
 * when a mutable toolchain variable names files the fingerprint hashes only
 * by spelling, or when it is sanitized (its runtime is compiled from sources
 * outside the pack, which the key does not observe). */
export function unchangedBuildKey(inputs: UnchangedBuildInputs): string | null {
  const { entry, options, ffi, ffiBytes, toolchain, output, translationUnitPath } = inputs;
  if (recordProfileBlocksPath(process.env) !== undefined) return null;
  if (options.sanitize === true) return null;
  // `-l<name>` and `-framework <name>` resolve through the linker's search
  // paths, and the key names the manifest's names, not the files they resolve
  // to: the file can be replaced in place and a kept executable would still be
  // the earlier link. The complete-artifact cache refuses that link for the
  // same reason.
  if (ffi !== null && (ffi.systemLibraries.length > 0 || (ffi.frameworks?.length ?? 0) > 0))
    return null;
  // The toolchain's linker arguments are opaque here: a `-l` name, a `-L`
  // directory or a driver name such as `cc` makes the linker resolve archives
  // through search paths the key does not observe, so an archive replaced in
  // place would leave a kept executable from the earlier link. The
  // complete-artifact cache refuses a link that supplies them for the same
  // reason.
  if (toolchain.linkerArgs.length > 0) return null;
  // A caller-selected linker or code-generation helper may be a wrapper that
  // brings inputs of its own — the key names the wrapper's file, its arguments
  // and the environment's spelling, not the archives, libraries or plugin
  // files the wrapper reads. The complete-artifact cache and the linker job
  // cache refuse a build that names either one, for the same reason.
  if (
    process.env["SCRIPTC_LINKER"] !== undefined ||
    process.env["SCRIPTC_LLVM_HELPER"] !== undefined
  )
    return null;
  // The mutable toolchain variables name files and directories that can change
  // behind a stable spelling — search paths, SDKs, config files, include
  // paths — while the fingerprint only hashes the spelling. The
  // complete-artifact cache refuses those too, through this same policy.
  if (!toolchainEnvironmentCachePolicy().completeArtifacts) return null;
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
        // The pack's manifest selects the artifacts a link consumes; its
        // package.json names the pack.
        runtimePack: [
          nativeFileIdentity(join(toolchain.runtimePackRoot, "package.json")),
          optionalIdentity(join(toolchain.runtimePackRoot, "runtime-pack.json")),
        ],
        linker: [toolchain.linker, toolchain.linkerArgs, commandIdentity(toolchain.linker)],
        dsymutil: debug ? commandIdentity(toolchain.dsymutil) : null,
        environment: toolchainEnvironmentFingerprint(),
        profile:
          options.profileUse === undefined
            ? null
            : [
                inputDigest(options.profileUse),
                inputDigest(profileBlocksPath(resolve(options.profileUse))),
              ],
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
  /** The runtime pack artifacts the build consumed (see the record's). */
  packInputs: readonly string[];
  profileMatch?: NativeProfileMatch;
}

/** Highest number of files a recorded beside directory may hold; a larger one
 * is not recorded, which only costs a rebuild. */
const MAX_BESIDE_FILES = 4096;

/** The identities a beside path contributes: the file itself, or, for a
 * directory — a Darwin `.dSYM` bundle — its identity and the identity of every
 * file in it. Tools that edit a build's debug information rewrite the DWARF
 * file in place, which leaves the bundle directory's own identity unchanged;
 * recording only the directory would let a kept executable stand beside debug
 * information of an older build. */
function besideIdentities(path: string): InputIdentity[] | null {
  try {
    if (!statSync(path).isDirectory()) return [identity(path)];
  } catch {
    return null;
  }
  const identities: InputIdentity[] = [];
  const walk = (directory: string): boolean => {
    let names;
    try {
      names = readdirSync(directory);
      identities.push(identity(directory));
    } catch {
      return false;
    }
    for (const name of names) {
      if (identities.length >= MAX_BESIDE_FILES) return false;
      const child = join(directory, name);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(child).isDirectory();
      } catch {
        return false;
      }
      if (isDirectory) {
        if (!walk(child)) return false;
        continue;
      }
      try {
        identities.push(identity(child));
      } catch {
        return false;
      }
    }
    return true;
  };
  return walk(path) ? identities : null;
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
      const installed = besideIdentities(path);
      if (installed === null) return;
      beside.push(...installed);
    }
    const packInputs: InputIdentity[] = [];
    for (const path of build.packInputs) {
      const input = file(path);
      if (input === null) return;
      packInputs.push(input);
    }
    const record: UnchangedBuildRecord = {
      schema: "scriptc.native-unchanged.v1",
      probes: build.probes,
      output,
      translationUnit,
      ir,
      beside,
      packInputs,
      ...(build.profileMatch === undefined ? {} : { profileMatch: build.profileMatch }),
    };
    cache.write("unchanged", key, JSON.stringify(record));
  } catch {
    /* An unavailable cache only prevents reuse. */
  }
}
