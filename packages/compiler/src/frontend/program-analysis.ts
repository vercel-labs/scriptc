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
  cycleEarlyBindings: EarlyBindingsMemo | null = null;
  /** Whether some program file can name node:child_process (namesChildProcess). */
  namesChildProcess: boolean | null = null;
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
    this.cycleEarlyBindings = null;
    this.namesChildProcess = null;
    this.moduleEarlyBindings = null;
    this.requireEarlyReferences.clear();
    this.requireFirstRunnable.clear();
    this.splitRequireBindings.clear();
    this.fileIdentifiers.clear();
  }
}
