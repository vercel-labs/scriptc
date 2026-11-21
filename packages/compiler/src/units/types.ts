/* Separate compilation (M0): the unit graph, the unit key, the unit store and
 * the summary format. This module holds the plain data types the frontend
 * hands the observer and the observer writes to the store. Nothing here reads
 * the program; the pieces that do live beside it.
 *
 * A unit is a package: the SDK runtime, an npm `package@version`, or the app.
 * M0 only observes: it computes the graph, keys and summaries after a normal
 * build and reports what a package's lowering facts would cost, and it changes
 * no build's output. */

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

/** Every program file's package attribution and the resolved module edges:
 * all the graph needs, and all of it a pure function of the load. */
export interface UnitObservationInput {
  /** The entry file (absolute). Its package is the app unit. */
  entry: string;
  files: readonly UnitFileInput[];
  edges: readonly UnitFileEdge[];
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

/** Everything a successful observe lowering returns to its host. */
export interface UnitObservation {
  entry: string;
  files: readonly UnitFileInput[];
  edges: readonly UnitFileEdge[];
  lowering: UnitLoweringData;
  classes: readonly { file: string; name: string; id: number; slots: readonly string[] }[];
  /** The program's runtime features. M0 does not restrict them per unit, so
   * the summary marks the field program-wide. */
  runtimeFeatures: Readonly<Record<string, boolean>>;
}

/** One unit's summary, in the canonical form written to the store. */
export interface UnitSummary {
  schema: "scriptc.unit-summary.v0";
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
}
