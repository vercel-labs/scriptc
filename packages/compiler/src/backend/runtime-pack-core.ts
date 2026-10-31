/** Runtime-pack schema and selection shared by compiler hosts. Filesystem
 * discovery, artifact verification and staging belong to the calling host. */
import { optimizationClass, type NativeOptimization } from "./optimization.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "./runtime-abi.js";
import type { NativeTargetSpec } from "./targets.js";

export const RUNTIME_PACK_SCHEMA = "scriptc.runtime-pack.v1" as const;
export const RUNTIME_PACK_FORMAT = 1 as const;

export type RuntimePredicate =
  | boolean
  | string
  | { all?: string[]; any?: string[]; not?: string[] };

export interface RuntimePackArtifact {
  path: string;
  sha256: string;
  size: number;
}

export interface RuntimePackVariant extends RuntimePackArtifact {
  id: string;
  when: Record<string, boolean>;
  defines: string[];
}

interface RuntimePackUnit {
  source: string;
  predicate: RuntimePredicate;
  variants: RuntimePackVariant[];
}

interface RuntimePackArchive extends RuntimePackArtifact {
  id: "quickjs" | "libregexp" | "zlib" | "brotli" | "mbedtls" | "icu";
  predicate: RuntimePredicate;
}

export type RuntimePackMode = "executable" | "library" | "library-thread";
export type RuntimePackFlavor =
  | "release"
  | "dev"
  | "speed"
  | "library-release"
  | "library-dev"
  | "library-thread-release"
  | "library-thread-dev";

interface RuntimePackFlavorManifest {
  optimization: "-O2" | "-O0";
  runtime_units: RuntimePackUnit[];
}

export interface RuntimePackManifest {
  schema: typeof RUNTIME_PACK_SCHEMA;
  format: typeof RUNTIME_PACK_FORMAT;
  package: string;
  version: string;
  target: {
    name: NativeTargetSpec["name"];
    llvm_triple: NativeTargetSpec["llvmTriple"];
    architecture: NativeTargetSpec["architecture"];
    object_format: NativeTargetSpec["objectFormat"];
    minimum_os: NativeTargetSpec["minimumOs"];
  };
  runtime_abi: { version: number; marker: string };
  compiler: { command: string; identity: string; target: string };
  macros: {
    executable: string[];
    excluded: string[];
    sanitizer: "external-toolchain-required";
  };
  flavors: Partial<Record<RuntimePackFlavor, RuntimePackFlavorManifest>>;
  archives: RuntimePackArchive[];
  /** Files the linked executable needs at RUN time rather than at link time,
   * installed beside it on every build. ICU's data file (icudt78l.dat, 11.1
   * MiB) is the only one; Intl programs copy it, every other program links
   * neither ICU nor its data. */
  data?: RuntimePackArtifact[];
  /** C headers under one include root (`<root>/unicode/*.h`): the ICU C API
   * headers scr_intl.c includes, which a sanitized build compiles that unit
   * against (native/sanitizer.ts). Only a pack that ships ICU lists them. */
  headers?: RuntimePackArtifact[];
  system_libraries: { name: string; predicate: RuntimePredicate }[];
  licenses: { path: string; license: string }[];
}

export interface RuntimeFeatureSet extends NativeLinkFeatures {
  workers: boolean;
  youngNursery: boolean;
  eventTarget: boolean;
  wasm: boolean;
  dynTier: boolean;
  streamDyn: boolean;
  handleProps: boolean;
  dynInherited: boolean;
  dynGlobalConstruct: boolean;
  childLifecycle: boolean;
  childOptionExt: boolean;
  declAdopt: boolean;
  typeOrigins: boolean;
  dynForAwait: boolean;
  dynIntegrityQueries: boolean;
  eventsOnceSignal: boolean;
  mime: boolean;
  largePages: boolean;
  webStreams: boolean;
  abortSignal: boolean;
  utilTiming: boolean;
  dynBuffer: boolean;
  builtinValues: boolean;
  /** A standard library prototype object read as a value in a JavaScript
   * source (scr_dyn_stdlib_prototype.c). */
  stdlibPrototypeValue?: boolean;
  /** Array.prototype's generic algorithms over array-likes
   * (scr_dyn_array_like.c). */
  arrayLikeDispatch?: boolean;
  /** Number.prototype and Boolean.prototype as values
   * (scr_dyn_builtin_prototype.c). */
  builtinPrototypeValue?: boolean;
  computedRequire: boolean;
  warningReplace: boolean;
  recordViewPartial: boolean;
  stdioExtended: boolean;
  /** The program's write completion callbacks take the error argument:
   * the SCR_STREAM_WRITE_ERRORS build of the stream unit. */
  streamWriteErrors: boolean;
  /** The program reaches the process output streams' write slot: the
   * SCR_STDIO_WRITE_SLOT build of the events unit. */
  stdioWriteSlot: boolean;
  nodeIsland: boolean;
  brotli: boolean;
  moduleNamespace: boolean;
  moduleNamespaceDyn: boolean;
  primitiveWrapper: boolean;
  nativeFetch: boolean;
  abortSignalOnly: boolean;
  netEffective: boolean;
  httpEffective: boolean;
  tlsEffective: boolean;
  tlsCaEffective: boolean;
  zlibEffective: boolean;
}

export class RuntimePackError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "invalid" | "unsupported",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RuntimePackError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validPredicate(value: unknown): value is RuntimePredicate {
  if (typeof value === "boolean" || typeof value === "string") return true;
  const item = object(value);
  if (item === null) return false;
  const keys = Object.keys(item);
  if (keys.some((key) => key !== "all" && key !== "any" && key !== "not")) return false;
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        Array.isArray(item[key]) &&
        (item[key] as unknown[]).every((feature) => typeof feature === "string"),
    )
  );
}

function validArtifact(value: unknown): value is RuntimePackArtifact {
  const item = object(value);
  return (
    item !== null &&
    typeof item.path === "string" &&
    !item.path.startsWith("/") &&
    !item.path.split(/[\\/]/).includes("..") &&
    validDigest(item.sha256) &&
    typeof item.size === "number" &&
    Number.isInteger(item.size) &&
    item.size >= 0
  );
}

export function parseRuntimePackManifest(value: unknown): RuntimePackManifest {
  const manifest = object(value);
  const target = object(manifest?.target);
  const abi = object(manifest?.runtime_abi);
  const compiler = object(manifest?.compiler);
  const macros = object(manifest?.macros);
  const flavors = object(manifest?.flavors);
  const validFlavor = (value: unknown, optimization: string): boolean => {
    const flavor = object(value);
    return (
      flavor?.optimization === optimization &&
      Array.isArray(flavor.runtime_units) &&
      flavor.runtime_units.every((raw) => {
        const unit = object(raw);
        return (
          typeof unit?.source === "string" &&
          validPredicate(unit.predicate) &&
          Array.isArray(unit.variants) &&
          unit.variants.length > 0 &&
          unit.variants.every((variantRaw) => {
            const variant = object(variantRaw);
            const when = object(variant?.when);
            return (
              validArtifact(variantRaw) &&
              typeof variant?.id === "string" &&
              when !== null &&
              Object.values(when).every((entry) => typeof entry === "boolean") &&
              Array.isArray(variant.defines) &&
              variant.defines.every((entry) => typeof entry === "string")
            );
          })
        );
      })
    );
  };
  if (
    manifest?.schema !== RUNTIME_PACK_SCHEMA ||
    manifest.format !== RUNTIME_PACK_FORMAT ||
    typeof manifest.package !== "string" ||
    typeof manifest.version !== "string" ||
    !isRuntimePackTarget(target) ||
    abi?.version !== RUNTIME_ABI_VERSION ||
    abi.marker !== RUNTIME_ABI_MARKER ||
    typeof compiler?.command !== "string" ||
    typeof compiler.identity !== "string" ||
    compiler.target !== target?.llvm_triple ||
    !Array.isArray(macros?.executable) ||
    !macros.executable.every((entry) => typeof entry === "string") ||
    !Array.isArray(macros.excluded) ||
    !macros.excluded.every((entry) => typeof entry === "string") ||
    macros.sanitizer !== "external-toolchain-required" ||
    flavors === null ||
    Object.keys(flavors).length === 0 ||
    Object.keys(flavors).some(
      (name) =>
        ![
          "release",
          "dev",
          "speed",
          "library-release",
          "library-dev",
          "library-thread-release",
          "library-thread-dev",
        ].includes(name),
    ) ||
    ((flavors.release !== undefined || flavors.dev !== undefined) &&
      (!validFlavor(flavors.release, "-O2") || !validFlavor(flavors.dev, "-O0"))) ||
    // The speed flavor is an optional companion of the executable flavors.
    (flavors.speed !== undefined && flavors.release === undefined) ||
    Object.entries(flavors).some(
      ([name, flavor]) => !validFlavor(flavor, name.endsWith("dev") ? "-O0" : "-O2"),
    ) ||
    !Array.isArray(manifest.archives) ||
    !manifest.archives.every((raw) => {
      const archive = object(raw);
      return (
        validArtifact(raw) && typeof archive?.id === "string" && validPredicate(archive.predicate)
      );
    }) ||
    (manifest.data !== undefined &&
      (!Array.isArray(manifest.data) || !manifest.data.every(validArtifact))) ||
    (manifest.headers !== undefined &&
      (!Array.isArray(manifest.headers) || !manifest.headers.every(validArtifact))) ||
    !Array.isArray(manifest.system_libraries) ||
    !manifest.system_libraries.every((raw) => {
      const library = object(raw);
      return typeof library?.name === "string" && validPredicate(library.predicate);
    }) ||
    !Array.isArray(manifest.licenses) ||
    !manifest.licenses.every((raw) => {
      const license = object(raw);
      return typeof license?.path === "string" && typeof license.license === "string";
    })
  )
    throw new RuntimePackError(
      "installed runtime-pack.json is malformed or incompatible",
      "invalid",
    );
  return manifest as unknown as RuntimePackManifest;
}

function isRuntimePackTarget(target: Record<string, unknown> | null): boolean {
  return (
    target !== null &&
    typeof target.name === "string" &&
    typeof target.llvm_triple === "string" &&
    (target.architecture === "arm64" ||
      target.architecture === "x64" ||
      target.architecture === "wasm32") &&
    (target.object_format === "macho" ||
      target.object_format === "elf" ||
      target.object_format === "coff" ||
      target.object_format === "wasm") &&
    typeof target.minimum_os === "string"
  );
}

export function effectiveRuntimeFeatures(
  features: NativeLinkFeatures,
  _env: NodeJS.ProcessEnv = process.env,
): RuntimeFeatureSet {
  const nativeFetch = features.fetch;
  const netEffective = features.net || nativeFetch;
  const httpEffective = features.http || nativeFetch;
  const tlsEffective = features.tls || nativeFetch;
  const tlsCaEffective = features.tlsCa || tlsEffective;
  return {
    ...features,
    fsBufferBrand: features.fsBufferBrand === true,
    workers: features.workers === true,
    youngNursery: features.youngNursery === true,
    eventTarget: features.eventTarget === true,
    wasm: features.wasm === true,
    dynTier: features.dynTier === true,
    streamDyn: features.streamDyn === true,
    handleProps: features.handleProps === true,
    dynInherited: features.dynInherited === true,
    dynGlobalConstruct: features.dynGlobalConstruct === true,
    childLifecycle: features.childLifecycle === true,
    childOptionExt: features.childOptionExt === true,
    declAdopt: features.declAdopt === true,
    typeOrigins: features.typeOrigins === true,
    dynForAwait: features.dynForAwait === true,
    dynIntegrityQueries: features.dynIntegrityQueries === true,
    eventsOnceSignal: features.eventsOnceSignal === true,
    mime: features.mime === true,
    largePages: features.largePages === true,
    webStreams: features.webStreams === true,
    abortSignal: features.abortSignal === true,
    utilTiming: features.utilTiming === true,
    dynBuffer: features.dynBuffer === true,
    builtinValues: features.builtinValues === true,
    stdlibPrototypeValue: features.stdlibPrototypeValue === true,
    arrayLikeDispatch: features.arrayLikeDispatch === true,
    builtinPrototypeValue: features.builtinPrototypeValue === true,
    computedRequire: features.computedRequire === true,
    warningReplace: features.warningReplace === true,
    recordViewPartial: features.recordViewPartial === true,
    stdioExtended: features.stdioExtended === true,
    streamWriteErrors: features.streamWriteErrors === true,
    stdioWriteSlot: features.stdioWriteSlot === true,
    nodeIsland: features.nodeIsland === true,
    brotli: features.brotli === true,
    moduleNamespace: features.moduleNamespace === true,
    moduleNamespaceDyn: features.moduleNamespaceDyn === true,
    primitiveWrapper: features.primitiveWrapper === true,
    nativeFetch,
    // The fetch unit has AbortController and AbortSignal; scr_abort.c is
    // the same implementation without the fetch transport.
    abortSignalOnly: features.abortSignal === true && !nativeFetch,
    netEffective,
    httpEffective,
    tlsEffective,
    tlsCaEffective,
    zlibEffective: features.zlib || nativeFetch,
  };
}

export function evaluateRuntimePredicate(predicate: RuntimePredicate, features: object): boolean {
  const values = features as Record<string, boolean>;
  if (typeof predicate === "boolean") return predicate;
  if (typeof predicate === "string") return values[predicate] === true;
  return (
    (predicate.all?.every((name) => values[name] === true) ?? true) &&
    (predicate.any?.some((name) => values[name] === true) ?? true) &&
    (predicate.not?.every((name) => values[name] !== true) ?? true)
  );
}

function selectVariant(unit: RuntimePackUnit, features: RuntimeFeatureSet): RuntimePackVariant {
  const matches = unit.variants.filter((variant) =>
    Object.entries(variant.when).every(
      ([name, expected]) => features[name as keyof RuntimeFeatureSet] === expected,
    ),
  );
  matches.sort(
    (a, b) => Object.keys(b.when).length - Object.keys(a.when).length || a.id.localeCompare(b.id),
  );
  const selected = matches[0];
  if (selected === undefined) {
    throw new RuntimePackError(`runtime pack has no variant for ${unit.source}`, "invalid");
  }
  if ((features.workers === true) !== selected.defines.includes("SCR_WORKERS")) {
    throw new RuntimePackError(
      `runtime pack has an incompatible thread-state variant for ${unit.source}; reinstall the matching runtime package`,
      "invalid",
    );
  }
  return selected;
}

/** Validate package and target identity before selecting any native input. */
export function validateRuntimePackIdentity(
  manifest: RuntimePackManifest,
  packageName: string | undefined,
  packageVersion: string | undefined,
  target: NativeTargetSpec,
  compilerVersion: string,
): void {
  if (
    packageName !== target.runtimePackPackage ||
    manifest.package !== target.runtimePackPackage ||
    packageVersion !== compilerVersion ||
    manifest.version !== compilerVersion
  ) {
    throw new RuntimePackError(
      `runtime pack version mismatch: expected ${target.runtimePackPackage}@${compilerVersion}, found package ${packageName}@${packageVersion} with manifest ${manifest.package}@${manifest.version}`,
      "invalid",
    );
  }
  if (
    manifest.target.name !== target.name ||
    manifest.target.llvm_triple !== target.llvmTriple ||
    manifest.target.architecture !== target.architecture ||
    manifest.target.object_format !== target.objectFormat ||
    manifest.target.minimum_os !== target.minimumOs
  )
    throw new RuntimePackError(`runtime pack does not support target ${target.name}`, "invalid");
}

export interface RuntimePackArtifacts {
  features: RuntimeFeatureSet;
  /** Selected unit variants. */
  runtime: RuntimePackArtifact[];
  archives: RuntimePackArtifact[];
  /** Files to install beside the executable (ICU's data file for Intl). */
  data: RuntimePackArtifact[];
  systemLibraries: string[];
}

/** The manifest flavor a posture links. Speed selects the executable `speed`
 * flavor when the pack ships one (size-for-speed runtime objects) and the
 * release flavor otherwise; library modes have no speed flavor and link
 * their release objects. */
export function runtimePackFlavorKey(
  manifest: RuntimePackManifest,
  optimization: NativeOptimization,
  mode: RuntimePackMode = "executable",
): RuntimePackFlavor {
  const optimized = optimizationClass(optimization);
  if (mode === "library") return optimized === "release" ? "library-release" : "library-dev";
  if (mode === "library-thread")
    return optimized === "release" ? "library-thread-release" : "library-thread-dev";
  if (optimization === "speed" && manifest.flavors.speed !== undefined) return "speed";
  return optimized;
}

/** The units a flavor links for `features`, each with its selected
 * variant. Variants of one unit can share an artifact file (the pack stores
 * identical objects once), so a variant is identified by its unit and id,
 * not by its path. */
export function selectedRuntimeUnits(
  flavor: RuntimePackFlavorManifest,
  features: RuntimeFeatureSet,
): { source: string; variant: RuntimePackVariant }[] {
  return flavor.runtime_units
    .filter((unit) => evaluateRuntimePredicate(unit.predicate, features))
    .map((unit) => ({ source: unit.source, variant: selectVariant(unit, features) }));
}

/** Selection is deterministic and independent of installation paths. Both
 * hosts verify and privately stage exactly these artifacts before linking. */
export function selectRuntimePackArtifacts(
  manifest: RuntimePackManifest,
  requested: NativeLinkFeatures,
  flavor: NativeOptimization,
  env: NodeJS.ProcessEnv = process.env,
  mode: RuntimePackMode = "executable",
): RuntimePackArtifacts {
  const features = effectiveRuntimeFeatures(requested, env);
  if (features.workers && (mode !== "executable" || manifest.target.object_format === "wasm"))
    throw new RuntimePackError("worker threads require a native static executable", "unsupported");
  const key = runtimePackFlavorKey(manifest, flavor, mode);
  const selectedFlavor = manifest.flavors[key];
  if (selectedFlavor === undefined)
    throw new RuntimePackError(
      `runtime pack has no ${key} flavor; reinstall the matching runtime package`,
      "invalid",
    );
  // Intl needs the ICU objects only the host-flavored packs carry (ICU is
  // C++, so a pack builds it with Zig's C++ driver for its own glibc target);
  // say so instead of linking a program whose scr_intl.c references would go
  // undefined.
  if (
    features.intl === true &&
    !selectedFlavor.runtime_units.some((unit) => unit.source === "scr_intl.c")
  )
    throw new RuntimePackError(
      `the ${manifest.target.name} runtime pack has no ICU objects, which Intl needs; reinstall a runtime package that supports Intl`,
      "unsupported",
    );
  return {
    features,
    runtime: selectedRuntimeUnits(selectedFlavor, features).map(({ variant }) => variant),
    archives: manifest.archives.filter((archive) =>
      evaluateRuntimePredicate(archive.predicate, features),
    ),
    // ICU's data file is 11.1 MiB: only a program that links ICU installs it.
    data: features.intl === true ? (manifest.data ?? []) : [],
    systemLibraries: manifest.system_libraries
      .filter((entry) => evaluateRuntimePredicate(entry.predicate, features))
      .map((entry) => entry.name),
  };
}
