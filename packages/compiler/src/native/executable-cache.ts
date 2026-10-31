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
import type { NativeLinkFeatures } from "../backend/native-link-info.js";
import type { NativeOptimization } from "../backend/optimization.js";
import type { NativeRuntimeSelection } from "../backend/runtime-pack-native.js";
import type { NativeToolchain } from "./toolchain.js";
import { contentDigest, NativeCache } from "./cache.js";
import type { LinkerJobLink } from "./linker-job.js";

export interface InputIdentity {
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

export function identity(path: string): InputIdentity {
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

export function stillMatches(inputs: InputIdentity[]): boolean {
  try {
    return inputs.every((input) => sameIdentity(identity(input.path), input));
  } catch {
    return false;
  }
}

export function commandPath(command: string): string {
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

export function tracePaths(output: string, driver: boolean, roots: string[]): string[] {
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

/** Linux: the output a build left, which an unchanged rebuild keeps while
 * the output and every input keep their identities. */
interface KeptEntry {
  schema: "scriptc.native-kept.v1";
  output: InputIdentity;
  inputs: InputIdentity[];
}

export function validIdentity(input: InputIdentity): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    typeof input.path === "string" &&
    isAbsolute(input.path) &&
    typeof input.canonical === "string" &&
    (input.kind === "file" || input.kind === "directory") &&
    [input.dev, input.ino, input.size, input.mtime, input.ctime].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  );
}

function validKept(value: unknown): value is KeptEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<KeptEntry>;
  return (
    entry.schema === "scriptc.native-kept.v1" &&
    entry.output !== undefined &&
    validIdentity(entry.output) &&
    Array.isArray(entry.inputs) &&
    entry.inputs.length > 0 &&
    entry.inputs.every(validIdentity)
  );
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
    entry.inputs.every(validIdentity)
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
  /** The inputs of the entry restore() used. */
  private restoredInputs: InputIdentity[] | null = null;
  private deferredAdded = false;

  constructor(
    private readonly cache: NativeCache,
    private readonly key: string,
    private readonly linker: string,
    private readonly debug: boolean,
    paths: string[],
    /** Linux: trace with one verbose link, keep an unchanged output, and
     * store the executable from a key's second link on. */
    private readonly linux = false,
    /** Inputs that the key determines, such as the runtime pack's selected
     * artifacts. keep() does not read them, because the entry it checks
     * lists them; restore() and trace() add their identities first. */
    private readonly deferredPaths: () => string[] = () => [],
  ) {
    this.inputs = [...new Set(paths)].sort().map(identity);
  }

  private addDeferredInputs(): void {
    if (this.deferredAdded) return;
    this.deferredAdded = true;
    const listed = new Set(this.inputs.map((input) => input.path));
    for (const path of this.deferredPaths())
      if (!listed.has(path)) {
        listed.add(path);
        this.inputs.push(identity(path));
      }
  }

  /** Whether `recorded`, the inputs of an entry, still match and cover this
   * build's inputs. */
  private covers(recorded: InputIdentity[]): boolean {
    if (!stillMatches(recorded) || !stillMatches(this.inputs)) return false;
    const saved = new Map(recorded.map((input) => [input.path, input]));
    return this.inputs.every((input) => {
      const found = saved.get(input.path);
      return found !== undefined && sameIdentity(found, input);
    });
  }

  /** Linux: true when `output` is the executable the last build of this key
   * left there, unchanged, and its inputs are unchanged; the caller keeps it. */
  keep(output: string): boolean {
    if (!this.linux) return false;
    try {
      const metadata = this.cache.read("kept", this.key);
      if (metadata === null) return false;
      const entry: unknown = JSON.parse(metadata.toString("utf8"));
      if (!validKept(entry)) return false;
      const current = identity(output);
      return sameIdentity(current, entry.output) && this.covers(entry.inputs);
    } catch {
      return false;
    }
  }

  restore(output: string): boolean {
    try {
      const metadata = this.cache.read("executable", this.key);
      if (metadata === null) return false;
      this.addDeferredInputs();
      const entry: unknown = JSON.parse(metadata.toString("utf8"));
      if (!validEntry(entry) || !this.covers(entry.inputs)) return false;
      if (this.debug !== (entry.symbols !== null)) return false;
      const binary = this.cache.read("binary", entry.binary);
      const symbols = entry.symbols === null ? null : this.cache.read("dsym", entry.symbols);
      if (binary === null || binary.length === 0 || (this.debug && symbols === null)) return false;
      if (!stillMatches(entry.inputs)) return false;
      if (symbols !== null) stageSymbols(symbols, output);
      writeFileSync(output, binary);
      chmodSync(output, 0o755);
      this.restoredInputs = entry.inputs;
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
   * false, the caller links the output itself. On Linux, `job` runs the
   * traced link as its recorded linker job when it can, and otherwise records
   * the job the driver ran (see LinkerJobs). */
  trace(args: string[], stage: string, job?: LinkerJobLink): boolean {
    this.traced = false;
    try {
      this.addDeferredInputs();
      const roots = [resolve(stage), realpathSync(stage)];
      let driverInputs = this.linux
        ? []
        : tracePaths(toolOutput(this.linker, [...args, "-###"]), true, roots).map(identity);
      // On Linux, -v prints the jobs that -### would, while the link runs.
      const traced = [...args, ...(this.linux ? ["-v"] : []), "-Wl,-t"];
      const direct = this.linux ? (job?.run(traced, false) ?? null) : null;
      const linked = direct?.output ?? toolOutput(this.linker, traced);
      if (this.linux) {
        driverInputs = direct?.driverInputs ?? tracePaths(linked, true, roots).map(identity);
        if (direct === null) job?.record(traced, linked, driverInputs);
      }
      const paths = tracePaths(linked, false, roots);
      if (paths.length === 0 || !stillMatches(this.inputs) || !stillMatches(driverInputs))
        return false;
      // The driver's job line and the linker's trace name many of the same
      // files; each is checked once.
      const listed = new Set(this.inputs.map((input) => input.path));
      for (const input of [...driverInputs, ...paths.map(identity)])
        if (!listed.has(input.path)) {
          listed.add(input.path);
          this.inputs.push(input);
        }
      this.traced = true;
      return true;
    } catch {
      return false;
    }
  }

  publish(output: string): void {
    try {
      // On Linux the first build of a key only records its output (see
      // recordOutput); the executable is stored once a later build relinks.
      if (!this.traced || (this.linux && !this.cache.has("kept", this.key))) return;
      if (!stillMatches(this.inputs)) return;
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

  /** Linux: records `output`, the executable this build left in place, for
   * keep(). */
  recordOutput(output: string): void {
    if (!this.linux) return;
    try {
      const inputs = this.traced ? this.inputs : this.restoredInputs;
      if (inputs === null || !stillMatches(inputs)) return;
      const entry: KeptEntry = {
        schema: "scriptc.native-kept.v1",
        output: identity(output),
        inputs,
      };
      this.cache.write("kept", this.key, JSON.stringify(entry));
    } catch {
      /* Build artifacts remain valid when caching is unavailable. */
    }
  }
}

/** The runtime pack an executable links: its directory, and the link features
 * and flavor that select its artifacts. `select` reads and validates the
 * manifest; the cache calls it only when it needs the artifacts' identities,
 * so an unchanged rebuild that keeps its output never reads the manifest. */
export interface ExecutableRuntimePack {
  root: string;
  features: NativeLinkFeatures;
  flavor: NativeOptimization;
  select: () => NativeRuntimeSelection;
}

export function openNativeExecutableCache(
  cache: NativeCache | null,
  toolchain: NativeToolchain,
  llvmDigest: () => string,
  options: CompileRequestOptions,
  ffi: FfiProfile | null,
  pack: ExecutableRuntimePack,
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
    ];
    const manifest = join(pack.root, "runtime-pack.json");
    if (platform === "linux") paths.push(manifest);
    // The manifest's identity, the features and the flavor in the key fix
    // which artifacts the selection names.
    const artifacts = (): string[] => {
      const selection = pack.select();
      return [
        ...selection.selected.runtime,
        ...selection.selected.archives,
        ...selection.licenses,
      ].map((artifact) => join(selection.root, artifact.path));
    };
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
        runtimeIdentity: readFileSync(join(pack.root, "package.json"), "utf8"),
        // On Linux the manifest's identity names it: restore checks that
        // identity again, as it does every other input.
        runtimeManifest:
          platform === "darwin" ? readFileSync(manifest, "utf8") : identity(manifest),
        runtimeFeatures: pack.features,
        runtimeFlavor: pack.flavor,
        linker: identity(linker),
        effective: identity(effective),
        environment: toolchainEnvironmentFingerprint(),
        cwd: process.cwd(),
        path: process.env["PATH"] ?? null,
      }),
    );
    return new NativeExecutableCache(
      cache,
      key,
      linker,
      debug,
      paths,
      platform === "linux",
      artifacts,
    );
  } catch {
    return null;
  }
}
