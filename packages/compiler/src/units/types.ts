/* Separate compilation (M0/M1): the unit graph, the unit key, the unit store
 * and the summary format. This module holds the plain data types the frontend
 * hands the observer and the observer writes to the store. Nothing here reads
 * the program; the pieces that do live beside it.
 *
 * A unit is a package: the SDK runtime, an npm `package@version`, or the app.
 * M1-1 still only observes: it records the key, the summary and the pin
 * vector after a normal build and reports which units a later build would
 * reuse, and it changes no build's output. */

/** One implementation source file of the loaded program, attributed to the
 * package that owns it. Paths are forward-slash and the relative path and
 * content digest carry no absolute path, so two apps' copies of one package
 * produce the same records. */
export interface UnitFileInput {
  /** Absolute path, forward slashes. Used only inside one build. */
  file: string;
  /** The file's path inside its package, forward slashes. */
  relative: string;
  /** The package's name, or null for a file that belongs to no package (it
   * joins the app unit). */
  packageName: string | null;
  /** The package's version, or "" when its package.json has none. */
  packageVersion: string | null;
  /** The package root's realpath, which tells two copies of one version
   * apart. Null for a file that belongs to no package. */
  packageRoot: string | null;
  /** sha256 of the file's content as the build read it. */
  digest: string;
}

/** A resolved module edge between two program files (absolute paths). */
export interface UnitFileEdge {
  from: string;
  to: string;
}

/** One implementation file of a package directory as installed, whether or
 * not this build reached it. */
export interface UnitPackageFile {
  /** The file's path inside the package, forward slashes. */
  relative: string;
  /** sha256 of the file's content. */
  digest: string;
}

/** An installed package directory the build loaded files from. A unit's file
 * set is this directory's files, not the subset the app reached: a package
 * whose reachable files shrink must keep its key, or a store entry for it
 * would miss for a reason that has nothing to do with its content. */
export interface UnitPackageDirectory {
  name: string;
  version: string;
  /** The package root's realpath; a build-local lookup key, never stored. */
  root: string;
  files: readonly UnitPackageFile[];
}

/** Every program file's package attribution and the resolved module edges:
 * all the graph needs, and all of it a pure function of the load. */
export interface UnitObservationInput {
  /** The entry file (absolute). Its package is the app unit. */
  entry: string;
  files: readonly UnitFileInput[];
  edges: readonly UnitFileEdge[];
  /** The installed package directories the build loaded files from. A unit
   * whose root appears here takes its file set from `files`; the app's own
   * package is not listed (its key may vary with its directory). */
  packages?: readonly UnitPackageDirectory[];
}

/** One unit of the graph. */
export interface UnitNode {
  /** `name@version`, plus a root-derived suffix for a second copy of the
   * same version; two units one SCC merges are joined by `+`. */
  id: string;
  name: string;
  version: string;
  /** Whether this is the entry's package (or the files outside any
   * package). */
  app: boolean;
  /** The unit's files as package-relative paths, sorted. */
  files: readonly string[];
  /** Direct dependency unit ids, sorted. */
  dependencies: readonly string[];
  /** The pre-merge unit ids this SCC contains, sorted (one entry when the
   * unit is not a merge). */
  mergedFrom: readonly string[];
}

export interface UnitGraph {
  /** Dependencies first (topological order), ties by id. */
  units: readonly UnitNode[];
  /** Every strongly connected component with more than one unit. */
  sccMerges: readonly { id: string; members: readonly string[] }[];
  stats: {
    files: number;
    units: number;
    edges: number;
    mergedUnits: number;
  };
}

/** One top-level declaration's lowering facts. */
export interface UnitDeclarationFact {
  /** Package-relative module path. */
  module: string;
  name: string;
  /** "function" | "class" | "variable" | "enum" | "namespace" |
   * "interface" | "type" | "export". */
  kind: string;
  /** The lowerer's `declarationFacts` text, position-free. */
  facts: string;
}

/** A generic declaration and the instances the build demanded of it. */
export interface UnitGenericFunctionFact {
  module: string;
  name: string;
  qualified: string;
  demanded: readonly { instance: string; by: string | null; byModule: string | null }[];
}

export interface UnitGenericClassFact {
  module: string;
  name: string;
  qualified: string;
  demanded: readonly { instance: string; by: string | null; byModule: string | null }[];
}

export interface UnitGenericsFact {
  functions: readonly UnitGenericFunctionFact[];
  classes: readonly UnitGenericClassFact[];
}

/** One demanded generic instance, before the observer attributes it to a
 * unit. `generic` is the family's program-qualified name, `instance` the
 * content-stable instance name the lowering gave it. */
export interface UnitGenericDemand {
  kind: "function" | "class";
  generic: string;
  instance: string;
  /** The package-relative module of the body that first demanded it, or
   * null when the demand came from outside any module (the entry's own
   * initialization, a synthetic root). */
  ownerModule: string | null;
}

/** A class's numbering as today's backend assigns it, so the leak report can
 * show the shift between apps. M1 makes it symbolic. */
export interface UnitClassFact {
  module: string;
  /** The class's IR (program-qualified) name. */
  name: string;
  /** Preorder class id (`classes.ts` buildClassGraph). */
  id: number;
  /** The method names the class's hierarchy assigns vtable slots to. */
  slots: readonly string[];
}

/** One program fact's value in this build. `setByOwnFiles` is true when the
 * unit's own files hold the occurrence that set it, false when none does,
 * and "unobserved" when the fact's state does not record where it was set. */
export interface UnitFactValue {
  value: string;
  setByOwnFiles: boolean | "unobserved";
}

/** A generic family declared in one module. */
export interface UnitGenericDeclaration {
  module: string;
  name: string;
  qualified: string;
}

/** The lowering data the observer needs beyond the graph and the module. */
export interface UnitLoweringData {
  declarations: readonly UnitDeclarationFact[];
  /** Per module, the sorted export names (the text `exportsOf` computes for
   * unit reuse). */
  exports: readonly { module: string; names: readonly string[] }[];
  generics: {
    functions: readonly UnitGenericDeclaration[];
    classes: readonly UnitGenericDeclaration[];
    demands: readonly UnitGenericDemand[];
  };
  inits: readonly { module: string; name: string }[];
  facts: Readonly<Record<string, UnitFactValue>>;
}

/** One function the lowering produced, attributed to the file whose body it
 * came from. The pin vector records the set a unit defines, so a warm build
 * can cut the reachable worklist at it and M1-3 can verify the stored IR
 * still holds exactly those functions. */
export interface UnitFunctionFact {
  /** Package-relative module path. */
  module: string;
  /** The function's IR name. */
  name: string;
}

/** The pin vector's lowerer-side data: the functions each unit defines.
 * `buildUnitSummary` narrows it per unit. */
export interface UnitPinData {
  functions: readonly UnitFunctionFact[];
}

/** Everything a successful observe lowering returns to its host. */
export interface UnitObservation {
  entry: string;
  files: readonly UnitFileInput[];
  edges: readonly UnitFileEdge[];
  packages?: readonly UnitPackageDirectory[];
  pins: UnitPinData;
  lowering: UnitLoweringData;
  classes: readonly { file: string; name: string; id: number; slots: readonly string[] }[];
  /** The program's runtime features. M0 does not restrict them per unit, so
   * the summary marks the field program-wide. */
  runtimeFeatures: Readonly<Record<string, boolean>>;
}

/** One unit's pins: what its lowered output was computed from beside its own
 * files. A warm build compares these against the stored entry (with the
 * facts beside them, which carry their own attribution) and reuses the entry
 * only when every value matches. See the handoff's "Fallback rule".
 *
 * M1-1 records the functions a unit defines and its classes' numbering. The
 * class-dispatch requests and the IC sites belong to M1-2, where their
 * names become content-derived and a per-unit identity exists to record. */
export interface UnitPins {
  /** Every function the unit's lowering produced, sorted by name. A warm
   * build must lower exactly the functions this list does not name. */
  functions: readonly string[];
  /** The classes the unit declares, with the preorder ids today's backend
   * assigns. M1-2 makes the ids symbolic; until then a shifted id is a pin
   * mismatch. */
  classes: readonly { name: string; id: number }[];
}

/** One unit's summary, in the canonical form written to the store. */
export interface UnitSummary {
  schema: "scriptc.unit-summary.v1";
  unit: {
    id: string;
    name: string;
    version: string;
    app: boolean;
  };
  files: readonly string[];
  exports: Record<string, readonly string[]>;
  declarations: readonly UnitDeclarationFact[];
  generics: UnitGenericsFact;
  classes: readonly UnitClassFact[];
  pins: UnitPins;
  runtimeFeatures: {
    scope: "program-wide";
    features: Readonly<Record<string, boolean>>;
  };
  inits: readonly { module: string; name: string }[];
  facts: Record<string, UnitFactValue>;
}

/** The metadata written beside a summary. */
export interface UnitStoreMeta {
  schema: "scriptc.unit-meta.v0";
  key: string;
  summaryDigest: string;
  summaryBytes: number;
  unit: UnitNode;
  /** The compiler implementation digest the key and this entry were made
   * with. */
  compiler: string | null;
  /** Each key payload field's digest: two stores can be compared field by
   * field when their keys differ (M0's leak report reads it). */
  keyParts: { [key: string]: string };
  timings: {
    graphMs: number;
    summaryMs: number;
    keyMs: number;
  };
  /** The IR this entry stores for a warm build (units/ir.ts). Absent when the
   * build wrote none: an observe build, the app unit, or a unit whose
   * lowering produced no function. */
  ir?: UnitStoreIr;
}

/** What a stored `ir.bin` holds, for its reader and the report. */
export interface UnitStoreIr {
  schema: "scriptc.unit-ir.v1";
  /** sha256 of `ir.bin`. */
  digest: string;
  bytes: number;
  functions: number;
  globals: number;
  classes: number;
  records: number;
  unions: number;
}
