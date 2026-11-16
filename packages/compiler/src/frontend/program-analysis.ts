import type {
  CallExpression,
  ExportDeclaration,
  Identifier,
  SourceFile,
  VariableDeclaration,
} from "./ts7/ast-types.js";
import type { ModuleSourceCandidates } from "./module-source-candidates.js";
import type { CycleEarlyBinding } from "./program.js";

/** Early bindings computed for one module order of a program. */
export interface EarlyBindingsMemo {
  key: string;
  bindings: CycleEarlyBinding[];
}

/** Facts owned by one program snapshot. Strong collections are bounded by
 * the program lifecycle, so neither GC finalizers nor native weak handles
 * are needed, and newer snapshots cannot inherit stale package decisions. */
export class ProgramAnalysis {
  readonly createRequireReasons = new Map<VariableDeclaration, string | null>();
  readonly nodeEsmFiles = new Map<SourceFile, boolean>();
  readonly prunedNpmReexports = new Set<ExportDeclaration>();
  readonly moduleSourceCandidates = new Map<SourceFile, ModuleSourceCandidates>();
  /** The modules of every import cycle the exact initialization rule admitted. */
  readonly exactCycleMembers = new Set<SourceFile>();
  /** CommonJS modules of require() cycles whose partially-initialized
   * exports are observable: their exports object is the live
   * checked-dynamic object Node hands a requiring module mid-cycle. */
  readonly partialCjsCycleMembers = new Set<SourceFile>();
  /** ES modules a require() call targets: each carries a %evaluating flag,
   * so require() of one that is still evaluating throws Node's
   * ERR_REQUIRE_CYCLE_MODULE at the call. */
  readonly requireEsmTargets = new Set<SourceFile>();
  cycleEarlyBindings: EarlyBindingsMemo | null = null;
  /** Whether some program file can name node:child_process (namesChildProcess). */
  namesChildProcess: boolean | null = null;
  /** Which member names a typed member call passes its holder for
   * (member-call-receivers.ts): null until the census is taken; `any` is
   * false for a program with no function that reads its call's receiver. */
  memberCallReceivers: { any: boolean; all: boolean; names: Set<string>; keyed: boolean } | null =
    null;
  /** Member names some implementation file writes, by name, for the void
   * truthiness rule (tsc-codes.ts methodNameWritten): a member the program
   * never writes keeps its undefined-returning dispatch. */
  readonly methodNameWrites = new Map<string, boolean>();
  /** Directories whose `lib.*.d.ts` files the checker holds as default
   * libraries, and those already asked about (isBundledLibraryFile). */
  readonly bundledLibraryDirectories = new Set<string>();
  readonly checkedLibraryDirectories = new Set<string>();
  moduleEarlyBindings: EarlyBindingsMemo | null = null;
  /** Top-level require declarations: the first reference to their bindings
   * that code running before the require can reach (requireEarlyReference). */
  readonly requireEarlyReferences = new Map<VariableDeclaration, Identifier | null>();
  /** Per file: the first top-level statement that can run user code. */
  readonly requireFirstRunnable = new Map<SourceFile, number>();
  /** Per file: split require bindings (`var m; m = require("./x")`), from
   * declaration to the require call of their one assignment
   * (splitRequireBindings7). */
  readonly splitRequireBindings = new Map<
    SourceFile,
    ReadonlyMap<VariableDeclaration, CallExpression>
  >();
  /** Per file: its identifiers by text, each with its position in the
   * file's preorder walk (fileIdentifiers). */
  readonly fileIdentifiers = new Map<
    SourceFile,
    ReadonlyMap<string, readonly { order: number; node: Identifier }[]>
  >();

  clear(): void {
    this.createRequireReasons.clear();
    this.nodeEsmFiles.clear();
    this.prunedNpmReexports.clear();
    this.moduleSourceCandidates.clear();
    this.exactCycleMembers.clear();
    this.partialCjsCycleMembers.clear();
    this.requireEsmTargets.clear();
    this.cycleEarlyBindings = null;
    this.namesChildProcess = null;
    this.methodNameWrites.clear();
    this.bundledLibraryDirectories.clear();
    this.checkedLibraryDirectories.clear();
    this.moduleEarlyBindings = null;
    this.requireEarlyReferences.clear();
    this.requireFirstRunnable.clear();
    this.splitRequireBindings.clear();
    this.fileIdentifiers.clear();
  }
}
