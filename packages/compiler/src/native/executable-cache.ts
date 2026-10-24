import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { driverTraceCandidates, linkTraceCandidate } from "../backend/link-trace.js";
import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "../backend/toolchain-environment.js";
import { runNativeTool } from "../backend/native-tools.js";
import type { NativeRuntimeSelection } from "../backend/runtime-pack-native.js";
import type { NativeToolchain } from "./toolchain.js";
import { contentDigest, NativeCache } from "./cache.js";

interface InputIdentity {
  path: string;
  canonical: string;
  kind: "file" | "directory";
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
}

interface ExecutableEntry {
  schema: "scriptc.native-executable.v1";
  inputs: InputIdentity[];
  binary: string;
  symbols: string | null;
}

function identity(path: string): InputIdentity {
  path = resolve(path);
  const info = statSync(path);
  if (!info.isFile() && !info.isDirectory())
    throw new Error(`unsupported native cache input: ${path}`);
  return {
    path,
    canonical: realpathSync(path),
    kind: info.isFile() ? "file" : "directory",
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtime: info.mtimeMs,
    ctime: info.ctimeMs,
  };
}

function sameIdentity(a: InputIdentity, b: InputIdentity): boolean {
  return (
    a.path === b.path &&
    a.canonical === b.canonical &&
    a.kind === b.kind &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.ctime === b.ctime
  );
}

function stillMatches(inputs: InputIdentity[]): boolean {
  try {
    return inputs.every((input) => sameIdentity(identity(input.path), input));
  } catch {
    return false;
  }
}

function commandPath(command: string): string {
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  for (const directory of (process.env["PATH"] ?? "/usr/bin:/bin").split(delimiter)) {
    const candidate = join(directory || process.cwd(), command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`native command is unavailable: ${command}`);
}

function toolOutput(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal !== null)
    throw new Error("could not trace native link inputs");
  return result.stdout + "\n" + result.stderr;
}

function tracePaths(output: string, driver: boolean, roots: string[]): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    for (const candidate of driver ? driverTraceCandidates(line) : linkTraceCandidate(line)) {
      const option = driver
        ? ["-L", "-F", "--sysroot="].find((prefix) => candidate.startsWith(prefix))
        : undefined;
      const spelling = option === undefined ? candidate : candidate.slice(option.length);
      if (!isAbsolute(spelling)) continue;
      const path = resolve(spelling);
      if (roots.some((root) => path === root || path.startsWith(root + "/"))) continue;
      try {
        const input = identity(path);
        paths.add(path);
        paths.add(dirname(path));
        if (input.kind === "directory" && path.endsWith(".sdk")) {
          for (const name of ["SDKSettings.json", "SDKSettings.plist"]) {
            const settings = join(path, name);
            try {
              identity(settings);
              paths.add(settings);
            } catch {
              /* The SDK directory observes new settings files. */
            }
          }
        }
      } catch {
        /* Non-path trace tokens are not dependencies. */
      }
    }
  }
  return [...paths].sort();
}

function validEntry(value: unknown): value is ExecutableEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<ExecutableEntry>;
  return (
    entry.schema === "scriptc.native-executable.v1" &&
    typeof entry.binary === "string" &&
    /^[0-9a-f]{64}$/.test(entry.binary) &&
    (entry.symbols === null ||
      (typeof entry.symbols === "string" && /^[0-9a-f]{64}$/.test(entry.symbols))) &&
    Array.isArray(entry.inputs) &&
    entry.inputs.length > 0 &&
    entry.inputs.every(
      (input) =>
        input !== null &&
        typeof input === "object" &&
        typeof input.path === "string" &&
        isAbsolute(input.path) &&
        typeof input.canonical === "string" &&
        (input.kind === "file" || input.kind === "directory") &&
        [input.dev, input.ino, input.size, input.mtime, input.ctime].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
    )
  );
}

function readSymbols(binary: string): Buffer {
  const contents = join(binary + ".dSYM", "Contents");
  const plist = readFileSync(join(contents, "Info.plist"));
  const dwarf = readFileSync(join(contents, "Resources", "DWARF", basename(binary)));
  const header = Buffer.alloc(12);
  header.write("SCDSYM01");
  header.writeUInt32LE(plist.length, 8);
  return Buffer.concat([header, plist, dwarf]);
}

function stageSymbols(bytes: Buffer, binary: string): void {
  if (bytes.length < 12 || bytes.subarray(0, 8).toString() !== "SCDSYM01")
    throw new Error("invalid cached dSYM");
  const end = 12 + bytes.readUInt32LE(8);
  if (end <= 12 || end >= bytes.length) throw new Error("invalid cached dSYM sizes");
  const contents = join(binary + ".dSYM", "Contents");
  const dwarf = join(contents, "Resources", "DWARF");
  mkdirSync(dwarf, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), bytes.subarray(12, end));
  writeFileSync(join(dwarf, basename(binary)), bytes.subarray(end));
}

/** A completed executable is reusable only after the frontend has validated
 * its source observations and emitted the same LLVM. Native inputs bracket
 * helper verification, runtime staging and the actual link. */
export class NativeExecutableCache {
  private inputs: InputIdentity[];
  private traced = false;
  /** Linux: no entry exists and the key was never linked before. */
  private readonly firstLink: boolean;

  constructor(
    private readonly cache: NativeCache,
    private readonly key: string,
    private readonly linker: string,
    private readonly debug: boolean,
    paths: string[],
    /** Linux: trace with one verbose link, from a key's second link on. */
    private readonly linux = false,
  ) {
    this.firstLink = linux && !cache.has("executable", key) && !cache.has("linked", key);
    // A first link neither restores nor traces, so it needs no identities.
    this.inputs = this.firstLink ? [] : [...new Set(paths)].sort().map(identity);
  }

  restore(output: string): boolean {
    if (this.firstLink) return false;
    try {
      const metadata = this.cache.read("executable", this.key);
      if (metadata === null) return false;
      const entry: unknown = JSON.parse(metadata.toString("utf8"));
      if (!validEntry(entry) || !stillMatches(entry.inputs) || !stillMatches(this.inputs))
        return false;
      const saved = new Map(entry.inputs.map((input) => [input.path, input]));
      if (
        !this.inputs.every((input) => {
          const recorded = saved.get(input.path);
          return recorded !== undefined && sameIdentity(recorded, input);
        })
      )
        return false;
      if (this.debug !== (entry.symbols !== null)) return false;
      const binary = this.cache.read("binary", entry.binary);
      const symbols = entry.symbols === null ? null : this.cache.read("dsym", entry.symbols);
      if (binary === null || binary.length === 0 || (this.debug && symbols === null)) return false;
      if (!stillMatches(entry.inputs)) return false;
      if (symbols !== null) stageSymbols(symbols, output);
      writeFileSync(output, binary);
      chmodSync(output, 0o755);
      return true;
    } catch {
      return false;
    }
  }

  /** Trace the real object-only link, including the SDK's transitive stubs.
   * Directories from the driver's search line detect a newly added candidate.
   * Private build inputs already belong to the LLVM/runtime cache identity.
   * A true result means the requested output was linked successfully and its
   * inputs remained stable. The caller can publish that output directly. On
   * false, the caller links the output itself. */
  trace(args: string[], stage: string): boolean {
    this.traced = false;
    try {
      // On Linux a key's first link only records that it was linked; a later
      // link of the same key traces, so a build that runs once traces nothing.
      if (this.firstLink) {
        this.cache.mark("linked", this.key);
        return false;
      }
      const roots = [resolve(stage), realpathSync(stage)];
      let driverInputs = this.linux
        ? []
        : tracePaths(toolOutput(this.linker, [...args, "-###"]), true, roots).map(identity);
      // On Linux, -v prints the jobs that -### would, while the link runs.
      const linked = toolOutput(this.linker, [...args, ...(this.linux ? ["-v"] : []), "-Wl,-t"]);
      if (this.linux) driverInputs = tracePaths(linked, true, roots).map(identity);
      const paths = tracePaths(linked, false, roots);
      if (paths.length === 0 || !stillMatches(this.inputs) || !stillMatches(driverInputs))
        return false;
      this.inputs.push(...driverInputs, ...paths.map(identity));
      this.traced = true;
      return true;
    } catch {
      return false;
    }
  }

  publish(output: string): void {
    try {
      if (!this.traced || !stillMatches(this.inputs)) return;
      const binary = readFileSync(output);
      const symbols = this.debug ? readSymbols(output) : null;
      const binaryKey = this.cache.writeContent("binary", binary);
      const symbolsKey = symbols === null ? null : this.cache.writeContent("dsym", symbols);
      if (!stillMatches(this.inputs)) return;
      const entry: ExecutableEntry = {
        schema: "scriptc.native-executable.v1",
        inputs: this.inputs,
        binary: binaryKey,
        symbols: symbolsKey,
      };
      this.cache.write("executable", this.key, JSON.stringify(entry));
    } catch {
      /* Build artifacts remain valid when caching is unavailable. */
    }
  }
}

export function openNativeExecutableCache(
  cache: NativeCache | null,
  toolchain: NativeToolchain,
  llvmDigest: () => string,
  options: CompileRequestOptions,
  ffi: FfiProfile | null,
  pack: NativeRuntimeSelection,
): NativeExecutableCache | null {
  // Match the established complete-cache contract: the default Apple driver
  // or a Linux clang driver, known runtime inputs, and no wrapper or
  // caller-supplied library searches.
  const platform = toolchain.target.platform;
  if (
    cache === null ||
    (platform !== "darwin" && platform !== "linux") ||
    options.sanitize ||
    // The key names a profile by path, not by its bytes.
    options.profileGenerate !== undefined ||
    options.profileUse !== undefined ||
    process.env["SCRIPTC_LINKER"] !== undefined ||
    process.env["SCRIPTC_LLVM_HELPER"] !== undefined ||
    toolchain.linkerArgs.length !== 0 ||
    ffi !== null ||
    !toolchainEnvironmentCachePolicy().completeArtifacts
  )
    return null;
  try {
    const linker = commandPath(toolchain.linker);
    // Apple's driver at /usr/bin/clang, or a clang driver on Linux. Both
    // name every input of a link in their -### and -Wl,-t traces.
    if (
      platform === "darwin"
        ? realpathSync(linker) !== "/usr/bin/clang"
        : !/^clang(-\d+)?$/.test(basename(realpathSync(linker)))
    )
      return null;
    // Apple's /usr/bin/clang is a shim for the active developer directory's
    // driver; a Linux clang driver is itself the driver.
    const effective =
      platform === "darwin"
        ? commandPath(runNativeTool(linker, ["-print-prog-name=clang"]).trim())
        : linker;
    // Linux keeps debug information in the executable; darwin keeps it in a
    // separate dSYM, which the cache stores beside the executable.
    const debug = platform === "darwin" && options.optimization === "dev" && !options.strip;
    const paths = [
      linker,
      effective,
      toolchain.helperExecutable,
      join(toolchain.helperPackageRoot, "package.json"),
      join(toolchain.runtimePackRoot, "package.json"),
      join(toolchain.runtimePackRoot, "runtime-pack.json"),
      ...[...pack.selected.runtime, ...pack.selected.archives, ...pack.licenses].map((artifact) =>
        join(pack.root, artifact.path),
      ),
    ];
    if (platform === "linux") paths.push(join(pack.root, "runtime-pack.json"));
    if (debug) {
      const dsymutil = commandPath(toolchain.dsymutil);
      if (realpathSync(dsymutil) !== "/usr/bin/dsymutil") return null;
      paths.push(dsymutil);
    }
    const key = contentDigest(
      JSON.stringify({
        schema: 1,
        llvm: llvmDigest(),
        options,
        toolchain,
        runtimeIdentity: pack.packageText,
        // On Linux the manifest's identity names it: restore checks that
        // identity again, as it does every other input.
        runtimeManifest:
          platform === "darwin"
            ? pack.manifestText
            : identity(join(pack.root, "runtime-pack.json")),
        linker: identity(linker),
        effective: identity(effective),
        environment: toolchainEnvironmentFingerprint(),
        cwd: process.cwd(),
        path: process.env["PATH"] ?? null,
      }),
    );
    return new NativeExecutableCache(cache, key, linker, debug, paths, platform === "linux");
  } catch {
    return null;
  }
}
