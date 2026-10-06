/** Runtime-pack schema and selection shared by compiler hosts. Filesystem
 * discovery, artifact verification and staging belong to the calling host. */
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

interface RuntimePackVariant extends RuntimePackArtifact {
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
  id: "quickjs" | "libregexp" | "zlib" | "mbedtls";
  predicate: RuntimePredicate;
}

export type RuntimePackMode = "executable" | "library" | "library-thread";
export type RuntimePackFlavor =
  | "release"
  | "dev"
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
  system_libraries: { name: string; predicate: RuntimePredicate }[];
  licenses: { path: string; license: string }[];
}

export interface RuntimeFeatureSet extends NativeLinkFeatures {
  nativeFetch: boolean;
  netIslandEffective: boolean;
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
          "library-release",
          "library-dev",
          "library-thread-release",
          "library-thread-dev",
        ].includes(name),
    ) ||
    ((flavors.release !== undefined || flavors.dev !== undefined) &&
      (!validFlavor(flavors.release, "-O2") || !validFlavor(flavors.dev, "-O0"))) ||
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
  env: NodeJS.ProcessEnv = process.env,
): RuntimeFeatureSet {
  const curlFetch = features.dynamic && features.fetch && env["SCRIPTC_FETCH_CURL"] === "1";
  if (curlFetch) {
    throw new RuntimePackError(
      "SCRIPTC_FETCH_CURL=1 is an external developer-toolchain comparison mode and is not available with precompiled runtime packs",
      "unsupported",
    );
  }
  const nativeFetch = features.fetch;
  const netIslandEffective = features.dynamic && (features.netIsland || nativeFetch);
  const netEffective = features.net || nativeFetch || netIslandEffective;
  const httpEffective = features.http || nativeFetch || netIslandEffective;
  const tlsEffective = features.tls || nativeFetch || netIslandEffective;
  const tlsCaEffective = features.tlsCa || tlsEffective;
  return {
    ...features,
    nativeFetch,
    netIslandEffective,
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
  runtime: RuntimePackArtifact[];
  archives: RuntimePackArtifact[];
  systemLibraries: string[];
}

/** Selection is deterministic and independent of installation paths. Both
 * hosts verify and privately stage exactly these artifacts before linking. */
export function selectRuntimePackArtifacts(
  manifest: RuntimePackManifest,
  requested: NativeLinkFeatures,
  flavor: "release" | "dev",
  env: NodeJS.ProcessEnv = process.env,
  mode: RuntimePackMode = "executable",
): RuntimePackArtifacts {
  const features = effectiveRuntimeFeatures(requested, env);
  const key: RuntimePackFlavor = mode === "executable" ? flavor : `${mode}-${flavor}`;
  const selectedFlavor =
    mode === "library"
      ? flavor === "release"
        ? manifest.flavors["library-release"]
        : manifest.flavors["library-dev"]
      : mode === "library-thread"
        ? flavor === "release"
          ? manifest.flavors["library-thread-release"]
          : manifest.flavors["library-thread-dev"]
        : flavor === "release"
          ? manifest.flavors.release
          : manifest.flavors.dev;
  if (selectedFlavor === undefined)
    throw new RuntimePackError(
      `runtime pack has no ${key} flavor; reinstall the matching runtime package`,
      "invalid",
    );
  if (mode !== "executable" && requested.dynamic)
    throw new RuntimePackError(
      "library runtime packs do not support dynamic execution",
      "unsupported",
    );
  return {
    features,
    runtime: selectedFlavor.runtime_units
      .filter((unit) => evaluateRuntimePredicate(unit.predicate, features))
      .map((unit) => selectVariant(unit, features)),
    archives: manifest.archives.filter((archive) =>
      evaluateRuntimePredicate(archive.predicate, features),
    ),
    systemLibraries: manifest.system_libraries
      .filter((entry) => evaluateRuntimePredicate(entry.predicate, features))
      .map((entry) => entry.name),
  };
}
