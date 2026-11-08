/* The program facts one island round's lowering passes share.
 *
 * lowerToIrWithIslands constructs a Lowerer per pass: validation, reachable
 * emit, the whole-slot comparison, the general-stream/dyn-stream relower, the
 * historical-order relower and the coverage remainder. Each pass lowers the
 * SAME loaded program and differs only in its mode flags, so the answers it
 * derives from the program alone (a file's path spelling, whether a file is
 * the standard library or an external type surface, a symbol's declaration
 * provenance, whether a type is an island handle, the admitted-opinion site
 * index, the package-file and declaration-boundary flags, the JavaScript
 * dynamic-declaration set, the class protocol index, the names each file's
 * identifiers spell, the module an import specifier names, and the module
 * specifiers a file of an island package holds) would be computed again
 * identically in every pass.
 *
 * This object computes each of them once per round. The rule for what may
 * live here: the answer must be a pure function of (program, island set,
 * external type surface) and must not read a Lowerer's mode flags, its unit
 * tables or any lowering state. The type memos (typeMemo, typeMemoShared,
 * scopedTypeMemos) fail that rule — generalNodeStreams, dynNodeStreams and
 * wholeSlotDegradation change what a type maps to — and stay per pass.
 *
 * A stale fact would be a silent miscompile, so the class also carries a
 * recompute-and-compare mode (SCRIPTC_LOWERING_FACTS_VERIFY=1, the shape of
 * type-mapper.ts's SCRIPTC_TYPE_MEMO_VERIFY): every hit is recomputed from
 * scratch and a disagreement throws, because the mode exists to prove the
 * sharing, never to rescue it at run time. */

import { resolve } from "node:path";
import * as ts from "../ts7/adapter.js";
import { InternalCompilerError } from "../../errors.js";
import { isDeclBoundaryFile } from "../decl-projection.js";
import {
  ambientDtsPath,
  isFallbackDtsPath,
  isNodeTypesPath,
  overridesDtsPath,
  tsgoPath,
} from "../dts-paths.js";
import {
  isForeignType,
  islandOwnerOfFile,
  islandSubclassCount,
  type NodeIslandSet,
} from "../../node-islands/boundary.js";
import { npmStaticDepSf7, resolveImport } from "../program.js";
import { ModuleSpecifierScans } from "../../node-islands/modules.js";
import { type AdmittedOpinion } from "../tsc-codes.js";
import { newSymbolProvenanceMemo, type SymbolProvenance } from "../type-mapper.js";
import { AsyncProtocolHolders } from "./async-protocol-holders.js";
import { ClassProtocols } from "./class-protocols.js";
import { inPackageFile } from "./decl-origin.js";
import { jsDynamicDeclarations } from "./js-dynamic-objects.js";
import { LayoutAdoptions } from "./layout-adoption.js";

/** SCRIPTC_LOWERING_FACTS_VERIFY: `1` recomputes and compares every shared
 * fact, `stats` does the same and also prints the hit count when the process
 * exits. */
const verifyMode = process.env["SCRIPTC_LOWERING_FACTS_VERIFY"] ?? "";
const verifyFromEnvironment = verifyMode === "1" || verifyMode === "stats";

/** The hits every verify-mode LoweringFacts has checked in this process
 * (tests assert the mode engaged; the `stats` variant prints it). */
let verifiedFactHits = 0;
const verifiedByFact = new Map<string, number>();
if (verifyMode === "stats")
  // One listener for the whole process: a round builds one facts object, and
  // a build runs several rounds.
  process.on("exit", () => {
    const parts: string[] = [];
    for (const [fact, hits] of verifiedByFact) parts.push(`${fact}=${hits}`);
    process.stderr.write(
      `[lowering-facts] verified ${verifiedFactHits} hits (${parts.join(" ") || "none"})\n`,
    );
  });

/** How many shared-fact hits SCRIPTC_LOWERING_FACTS_VERIFY has checked in
 * this process. Zero when the mode is off. */
export function verifiedLoweringFactHits(fact?: string): number {
  if (fact === undefined) return verifiedFactHits;
  return verifiedByFact.get(fact) ?? 0;
}

/** Records one verified hit in the process-wide counter, so `stats` and the
 * engagement test see every checked fact, including the Lowerer's own
 * per-pass comparisons (which call LoweringFacts.noteVerified). */
function recordVerified(fact: string): void {
  verifiedFactHits++;
  verifiedByFact.set(fact, (verifiedByFact.get(fact) ?? 0) + 1);
}

/** The admitted opinions' sites by file and code. */
type OpinionIndex = ReadonlyMap<string, readonly AdmittedOpinion[]>;

export interface LoweringFactsOptions {
  /** Override the SCRIPTC_LOWERING_FACTS_VERIFY environment (tests). */
  verify?: boolean;
}

/** The program facts every pass of one island round shares
 * (see the module comment for what may live here). */
export class LoweringFacts {
  /** A symbol belongs to one loaded program, and the mapper asks for its
   * provenance on every object type it maps. */
  readonly symbolProvenance: Map<ts.Symbol, SymbolProvenance> = newSymbolProvenanceMemo();
  /** The process-constant shipped declaration paths isStdlibFile compares. */
  private readonly ambient = ambientDtsPath();
  private readonly overridesAmbient = overridesDtsPath();
  /** pathOf's answers: a source file's path spelling cannot change. */
  private readonly filePaths = new Map<ts.SourceFile, string>();
  /** isStdlibFile's answers: a file's name and library status cannot change. */
  private readonly stdlibFiles = new Map<ts.SourceFile, boolean>();
  /** isExternalTypeFile's answers for `externalTypeSpecifiers`. */
  private readonly externalTypeFiles = new Map<ts.SourceFile, boolean>();
  /** foreignType's answers, by checker type id. */
  private readonly foreignTypeAnswers = new Map<number, boolean>();
  /** The island set and subclass count foreignTypeAnswers was computed at. */
  private foreignIslands: NodeIslandSet | null = null;
  private foreignChecker: ts.TypeChecker | null = null;
  private foreignSubclasses = -1;
  /** inPackageFileOf's answers, by source file. */
  private readonly packageFileMemo = new Map<ts.SourceFile, boolean>();
  private declBoundaryAnswer: boolean | null = null;
  /** The opinion index of one admitted-opinions list: every pass of a round
   * receives the same list from preflight. */
  private opinionIndexOpinions: readonly AdmittedOpinion[] | null = null;
  private opinionIndexValue: OpinionIndex | null = null;
  /** jsDynamicDeclarations over the round's moduleOrder. */
  private jsDynamic: ReadonlySet<ts.Node> | null = null;
  /** The opinion index and the JavaScript declaration set are whole-program
   * answers over immutable inputs: the verify mode proves each of them once
   * per round rather than on every hit. */
  private opinionIndexVerified = false;
  private jsDynamicVerified = false;
  private protocols: ClassProtocols | null = null;
  private asyncProtocols: AsyncProtocolHolders | null = null;
  /** maySpellIdentifier's index: by file, the hashes of the names its
   * identifiers spell. */
  private readonly identifierNames = new Map<ts.SourceFile, Set<number>>();
  /** importedModule's and npmStaticModule's answers, by importing file and
   * then by resolution kind and specifier. */
  private readonly importedModules = new Map<ts.SourceFile, Map<string, ts.SourceFile | null>>();
  private readonly npmStaticModules = new Map<ts.SourceFile, Map<string, ts.SourceFile | null>>();

  /** The module specifiers of the files Node loads (the island packages
   * and what they require): every pass collects those packages again
   * (NodeIslandModuleCollector) and plans the modules they share
   * (lower-shared-modules.ts) from the same files. Each answer is checked
   * against the file's text when it is used. */
  readonly moduleSpecifierScans = new ModuleSpecifierScans();

  /** Whether hits are recomputed and compared (SCRIPTC_LOWERING_FACTS_VERIFY). */
  readonly verify: boolean;
  private readonly verified = new Map<string, number>();

  constructor(
    readonly program: ts.Program,
    readonly moduleOrder: readonly ts.SourceFile[],
    /** The round's external type surface (LowerOptions.externalTypes as
     * externalTypeSpecifiersByFile): every pass receives the same map, and
     * isExternalTypeFile bypasses its cache when a caller's map differs. */
    private readonly externalTypeSpecifiers: ReadonlyMap<string, readonly string[]>,
    options: LoweringFactsOptions = {},
  ) {
    this.verify = options.verify ?? verifyFromEnvironment;
  }

  /** tsgoPath(resolve(sf.fileName)): the path spelling the module tables key
   * by. */
  pathOf(sf: ts.SourceFile): string {
    const known = this.filePaths.get(sf);
    if (known === undefined) {
      const path = tsgoPath(resolve(sf.fileName));
      this.filePaths.set(sf, path);
      return path;
    }
    return this.verifyHit("pathOf", known, () => tsgoPath(resolve(sf.fileName)));
  }

  /** True for the STANDARD LIBRARY's source files (Lowerer.isStdlibFile). */
  isStdlibFile = (sf: ts.SourceFile): boolean => {
    const known = this.stdlibFiles.get(sf);
    if (known === undefined) {
      const stdlib = this.computeStdlibFile(sf);
      this.stdlibFiles.set(sf, stdlib);
      return stdlib;
    }
    return this.verifyHit("isStdlibFile", known, () => this.computeStdlibFile(sf));
  };
  private computeStdlibFile(sf: ts.SourceFile): boolean {
    return (
      sf.fileName === this.ambient ||
      sf.fileName === this.overridesAmbient ||
      isFallbackDtsPath(sf.fileName) ||
      this.program.isSourceFileDefaultLibrary(sf) ||
      (sf.isDeclarationFile && isNodeTypesPath(sf.fileName))
    );
  }

  /** Whether the file holds declarations of an explicitly mapped external
   * type surface (coverage's --external-types) or of the declaration-typed
   * boundary's generated types. `externalTypeSpecifiers` is the asking
   * pass's map: a round hands every pass the same one, and the cache is
   * bypassed for any other. */
  isExternalTypeFile(
    sf: ts.SourceFile,
    externalTypeSpecifiers: ReadonlyMap<string, readonly string[]>,
  ): boolean {
    const compute = (): boolean =>
      externalTypeSpecifiers.has(this.pathOf(sf)) || isDeclBoundaryFile(sf.fileName);
    if (externalTypeSpecifiers !== this.externalTypeSpecifiers) return compute();
    const known = this.externalTypeFiles.get(sf);
    if (known === undefined) {
      const external = compute();
      this.externalTypeFiles.set(sf, external);
      return external;
    }
    return this.verifyHit("isExternalTypeFile", known, compute);
  }

  /** Whether values of `type` are island handles (boundary.ts's
   * isForeignType). The answer is a function of (island set, checker, type);
   * the one input that moves while a round runs is the island-subclass
   * registry (splitFiles registers native subclasses of island classes), so
   * a new registration drops every answer that predates it. */
  foreignType(type: ts.Type, islands: NodeIslandSet | null, checker: ts.TypeChecker): boolean {
    if (islands === null) return false;
    const subclasses = islandSubclassCount();
    if (
      this.foreignIslands !== islands ||
      this.foreignChecker !== checker ||
      this.foreignSubclasses !== subclasses
    ) {
      this.foreignTypeAnswers.clear();
      this.foreignIslands = islands;
      this.foreignChecker = checker;
      this.foreignSubclasses = subclasses;
    }
    const id = (type as { id?: number }).id;
    if (id === undefined) return isForeignType(islands, type, checker);
    const known = this.foreignTypeAnswers.get(id);
    if (known !== undefined)
      return this.verifyHit("foreignType", known, () => isForeignType(islands, type, checker));
    const foreign = isForeignType(islands, type, checker);
    this.foreignTypeAnswers.set(id, foreign);
    return foreign;
  }

  /** The admitted opinions' sites by file and code (Lowerer.opinionAt's
   * index). */
  opinionIndex(opinions: readonly AdmittedOpinion[]): OpinionIndex {
    if (this.opinionIndexOpinions === opinions && this.opinionIndexValue !== null) {
      if (this.verify && !this.opinionIndexVerified) {
        this.opinionIndexVerified = true;
        this.verifyOpinionIndex(opinions, this.opinionIndexValue);
      }
      return this.opinionIndexValue;
    }
    const built = buildOpinionIndex(opinions);
    this.opinionIndexOpinions = opinions;
    this.opinionIndexValue = built;
    return built;
  }
  private verifyOpinionIndex(opinions: readonly AdmittedOpinion[], known: OpinionIndex): void {
    const fresh = buildOpinionIndex(opinions);
    let same = fresh.size === known.size;
    if (same)
      for (const [key, sites] of fresh) {
        const theirs = known.get(key);
        if (theirs === undefined || theirs.length !== sites.length) {
          same = false;
          break;
        }
        for (let i = 0; i < sites.length; i++)
          if (sites[i] !== theirs[i]) {
            same = false;
            break;
          }
        if (!same) break;
      }
    this.countVerified("opinionIndex");
    if (same) return;
    throw new InternalCompilerError(
      "shared admitted-opinion index does not match a fresh index over the same opinions",
    );
  }

  /** Whether the node's file is package code (decl-origin.ts's
   * inPackageFile, memoized per file). */
  inPackageFile(node: ts.Node): boolean {
    const sf = ts.getSourceFileOfNode(node);
    const known = this.packageFileMemo.get(sf);
    if (known === undefined) {
      const inside = inPackageFile(node);
      this.packageFileMemo.set(sf, inside);
      return inside;
    }
    return this.verifyHit("inPackageFile", known, () => inPackageFile(node));
  }

  /** The program holds the declaration-typed boundary's projection. */
  get declBoundary(): boolean {
    const known = this.declBoundaryAnswer;
    if (known === null) {
      const boundary = this.program.getSourceFileNames().some(isDeclBoundaryFile);
      this.declBoundaryAnswer = boundary;
      return boundary;
    }
    return this.verifyHit("declBoundary", known, () =>
      this.program.getSourceFileNames().some(isDeclBoundaryFile),
    );
  }

  /** The JavaScript declarations whose instance or object-literal types only
   * the checked-dynamic representation holds (js-dynamic-objects.ts). */
  jsDynamicDeclarations(): ReadonlySet<ts.Node> {
    const known = this.jsDynamic;
    if (known === null) {
      const computed = jsDynamicDeclarations(this.moduleOrder, this.program.getTypeChecker());
      this.jsDynamic = computed;
      return computed;
    }
    if (!this.verify || this.jsDynamicVerified) return known;
    this.jsDynamicVerified = true;
    const fresh = jsDynamicDeclarations(this.moduleOrder, this.program.getTypeChecker());
    let same = fresh.size === known.size;
    if (same) for (const node of fresh) if (!known.has(node)) same = false;
    this.countVerified("jsDynamicDeclarations");
    if (same) return known;
    throw new InternalCompilerError(
      `shared JavaScript dynamic-declaration set does not match a fresh one: ` +
        `${known.size} shared, ${fresh.size} recomputed`,
    );
  }

  /** False only when no identifier of `sf` is spelled `name`. A search for
   * every use of one name over the whole program (deadUnmappableBinding)
   * asks each file before it walks it: the walk of a file that answers false
   * meets no identifier of that name, so it reads nothing and decides
   * nothing. The index holds a hash per name, and two names can share one,
   * so true means only that the file must be walked.
   *
   * A file is indexed by the walk those searches make (forEachChild from the
   * file), so the index sees exactly the identifiers they see. */
  maySpellIdentifier(sf: ts.SourceFile, name: string): boolean {
    let names = this.identifierNames.get(sf);
    if (names === undefined) {
      names = identifierNameHashes(sf);
      this.identifierNames.set(sf, names);
    }
    if (names.has(nameHash(name))) return true;
    if (this.verify) {
      this.countVerified("maySpellIdentifier");
      if (spellsIdentifier(sf, name))
        throw new InternalCompilerError(
          `shared lowering fact maySpellIdentifier does not match a fresh walk: ` +
            `'${name}' is spelled in ${sf.fileName}`,
        );
    }
    return false;
  }

  /** The program module `specifier` names when `from` imports or requires
   * it (program.ts's resolveImport), or null. Every reference to an imported
   * binding asks (Lowerer.resolveValueSymbol), and an answer walks the
   * candidate paths of the specifier: the program, its packages and the
   * files on disk do not change while a round lowers, so each (file, kind,
   * specifier) is resolved once. */
  importedModule(
    from: ts.SourceFile,
    specifier: string,
    kind: "import" | "require" = "import",
  ): ts.SourceFile | null {
    return this.moduleAnswer("importedModule", this.importedModules, from, specifier, kind, () =>
      resolveImport(this.program, from, specifier, kind),
    );
  }

  /** The module of a natively compiled package `specifier` names from `from`
   * (program.ts's npmStaticDepSf7), or null: resolved once, as importedModule
   * is. */
  npmStaticModule(
    from: ts.SourceFile,
    specifier: string,
    kind: "import" | "require" = "import",
  ): ts.SourceFile | null {
    return this.moduleAnswer("npmStaticModule", this.npmStaticModules, from, specifier, kind, () =>
      npmStaticDepSf7(this.program, from, specifier, kind),
    );
  }

  private moduleAnswer(
    fact: string,
    answers: Map<ts.SourceFile, Map<string, ts.SourceFile | null>>,
    from: ts.SourceFile,
    specifier: string,
    kind: "import" | "require",
    resolveModule: () => ts.SourceFile | null,
  ): ts.SourceFile | null {
    let ofFile = answers.get(from);
    if (ofFile === undefined) {
      ofFile = new Map();
      answers.set(from, ofFile);
    }
    const key = kind === "require" ? `r:${specifier}` : `i:${specifier}`;
    const known = ofFile.get(key);
    if (known === undefined) {
      const module = resolveModule();
      ofFile.set(key, module);
      return module;
    }
    return this.verifyHit(fact, known, resolveModule);
  }

  /** The program's class protocol index (class-protocols.ts). Each pass
   * asking its own questions must get the same answers; the Lowerer's verify
   * mode compares them against a fresh index per pass, so a pass that
   * registered an island (or otherwise edited declarations) mid-round and
   * changed an answer fails there instead of lowering a stale one. Nothing
   * may edit the program while a round lowers. */
  classProtocols(): ClassProtocols {
    this.protocols ??= new ClassProtocols(
      this.program.getTypeChecker(),
      this.moduleOrder,
      this.isStdlibFile,
    );
    return this.protocols;
  }

  /** The constant tables that are built in the layout of the structural
   * type the program reads them through (layout-adoption.ts): a pure
   * analysis of the checker and the program's modules, so every pass of the
   * round maps a table's type the same way. */
  layoutAdoptions(): LayoutAdoptions {
    this.adoptions ??= new LayoutAdoptions(this.program.getTypeChecker(), this.moduleOrder);
    return this.adoptions;
  }
  private adoptions: LayoutAdoptions | null = null;

  /** The async-iteration protocol types that hold a checked-dynamic value
   * (async-protocol-holders.ts): a pure analysis of the checker and the
   * program's modules (the round's entry and moduleOrder), so every pass of
   * the round maps a protocol type the same way. */
  asyncProtocolHolders(entry: ts.SourceFile, islands: NodeIslandSet | null): AsyncProtocolHolders {
    this.asyncProtocols ??= new AsyncProtocolHolders(
      this.program.getTypeChecker(),
      this.moduleOrder.includes(entry) ? this.moduleOrder : [...this.moduleOrder, entry],
      this.isStdlibFile,
      () => this.islandProtocolFiles(islands),
    );
    return this.asyncProtocols;
  }
  /** The files of the round's Node islands (their declarations, and island
   * modules of the program) whose text names an async-iteration protocol
   * interface. The names and the text are read without a syntax tree, so a
   * program whose islands never name one fetches none of their files. */
  islandProtocolFiles(islands: NodeIslandSet | null): readonly ts.SourceFile[] {
    if (islands === null) return [];
    const files: ts.SourceFile[] = [];
    for (const name of this.program.getSourceFileNames()) {
      if (islandOwnerOfFile(islands, name) === null) continue;
      if (this.program.getSourceText(name)?.includes("AsyncItera") !== true) continue;
      const file = this.program.getSourceFile(name);
      if (file !== undefined) files.push(file);
    }
    return files;
  }
  /** The analysis, once a pass has asked it (the timing line reads it). */
  get askedAsyncProtocolHolders(): AsyncProtocolHolders | null {
    return this.asyncProtocols;
  }

  private verifyHit<T>(fact: string, known: T, recompute: () => T): T {
    if (!this.verify) return known;
    const fresh = recompute();
    this.countVerified(fact);
    if (Object.is(known, fresh)) return known;
    throw new InternalCompilerError(
      `shared lowering fact ${fact} does not match a fresh computation: ` +
        `${String(known)} shared, ${String(fresh)} recomputed`,
    );
  }

  /** Records a check the Lowerer made against a shared answer, so the
   * per-facts count and the process-wide one agree. */
  noteVerified(fact: string): void {
    this.countVerified(fact);
  }

  private countVerified(fact: string): void {
    this.verified.set(fact, (this.verified.get(fact) ?? 0) + 1);
    recordVerified(fact);
  }

  /** How many hits the verify mode has checked, by fact (tests). */
  verifiedHits(fact: string): number {
    return this.verified.get(fact) ?? 0;
  }
}

/** FNV-1a over the name's UTF-16 code units, as a 32-bit integer. */
function nameHash(name: string): number {
  let hash = 0x811c9dc5 | 0;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  return hash;
}

/** The hashes of the names `sf`'s identifiers spell. */
function identifierNameHashes(sf: ts.SourceFile): Set<number> {
  const hashes = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) hashes.add(nameHash(node.text));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hashes;
}

/** Whether an identifier of `sf` is spelled `name`, by the same walk. */
function spellsIdentifier(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

function buildOpinionIndex(opinions: readonly AdmittedOpinion[]): OpinionIndex {
  const built = new Map<string, AdmittedOpinion[]>();
  for (const site of opinions) {
    const key = `${site.file}\0${site.code}`;
    const list = built.get(key);
    if (list === undefined) built.set(key, [site]);
    else list.push(site);
  }
  return built;
}
