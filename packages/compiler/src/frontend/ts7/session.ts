import { ts7Diagnostic, type Ts7Diagnostic } from "./diagnostic.js";
import type { SourceFile } from "./ast-types.js";
import { AstFile, AstNode } from "./ast-node.js";
import { Ts7RpcClient } from "./rpc-client.js";
import { SemanticChecker } from "./semantic-checker.js";
import { SemanticSnapshot, type SemanticDocument } from "./semantic-model.js";
import { parseSemanticJson } from "./semantic-json.js";
import { Ts7SourceCache } from "./session-cache.js";
import { Ts7Paths, ts7DocumentFile } from "./session-path.js";
import { Ts7Timing, type Ts7ServerTiming, type Ts7TimingInfo } from "./session-timing.js";
import type {
  Ts7CompilerOptionsData,
  Ts7ConfigData,
  Ts7DiagnosticData,
  Ts7ProjectChangeData,
  Ts7ProjectData,
  Ts7SnapshotData,
  Ts7SourceMetadata,
} from "./session-schema.generated.js";

/** Project options tsgo still reports for a tsconfig but the TS 7 SDK
 * schema no longer declares. scriptc adopts them (ADOPTED_OPTIONS), so the
 * options a project reports are parsed with them declared: a native
 * compiler keeps only declared fields when it parses the response. */
export interface Ts7ProjectCompilerOptions extends Ts7CompilerOptionsData {
  alwaysStrict?: boolean;
  esModuleInterop?: boolean;
  allowSyntheticDefaultImports?: boolean;
}

interface Ts7ReportedProjectData extends Ts7ProjectData {
  compilerOptions: Ts7ProjectCompilerOptions;
}

interface Ts7ReportedSnapshotData extends Ts7SnapshotData {
  projects: Ts7ReportedProjectData[];
}

/** initialize's answer. TypeScript 7.0 reports useCaseSensitiveFileNames;
 * 7.1 reports caseSensitivity (1 when case-sensitive) instead, which is how
 * a session tells the two protocols apart. */
interface Ts7InitializeReply {
  currentDirectory: string;
  useCaseSensitiveFileNames?: boolean;
  caseSensitivity?: number;
}

/** A project as TypeScript 7.1 reports it: the parsed command line carries
 * the root files and options, and a project need not have a config file. */
interface Ts71ProjectData {
  id: string;
  configFileName?: string;
  parsedCommandLine: { fileNames: string[]; options: Ts7ProjectCompilerOptions };
}

/** createSnapshot's and updateSnapshot's answer in TypeScript 7.1. An update
 * lists only the projects added or replaced since its base snapshot, and a
 * changed project's entry is null when its files are not listed. */
interface Ts71SnapshotData {
  snapshot: number;
  projects: Ts71ProjectData[];
  changes?: {
    changedProjects?: Record<string, Ts7ProjectChangeData | null>;
    removedProjects?: string[];
  };
}

/** TypeScript 7.1's compiler options in 7.0's values: 7.1 swaps JsxEmit's
 * React (2) and ReactNative (3). */
function options71<T extends { jsx?: number | undefined }>(options: T): T {
  if (options.jsx === 2) options.jsx = 3;
  else if (options.jsx === 3) options.jsx = 2;
  return options;
}

function project71(data: Ts71ProjectData): Ts7ReportedProjectData {
  return {
    id: data.id,
    configFileName: data.configFileName ?? data.id,
    compilerOptions: options71(data.parsedCommandLine.options),
    rootFiles: data.parsedCommandLine.fileNames,
  };
}

export interface Ts7FileChanges {
  changed?: SemanticDocument[];
  created?: SemanticDocument[];
  deleted?: SemanticDocument[];
  invalidateAll?: boolean;
}

export interface Ts7Update {
  openProjects?: SemanticDocument[];
  closeProjects?: SemanticDocument[];
  openFiles?: SemanticDocument[];
  closeFiles?: SemanticDocument[];
  fileChanges?: Ts7FileChanges;
}

interface ProgramQuery {
  snapshot?: number;
  project?: string;
  file?: SemanticDocument;
  files?: SemanticDocument[];
}

/** The answer of getDiagnosticsOfCheckedFiles, as the server sends it. */
export interface Ts7CheckedFileDiagnosticData {
  files: Ts7DiagnosticData[][];
  global: Ts7DiagnosticData[];
}

/** Platform-independent session over an already connected transport. The
 * host chooses how to start tsgo; no JavaScript SDK constructs the snapshot,
 * program, AST, or semantic objects exposed by this client. */
export class Ts7Session {
  readonly cache = new Ts7SourceCache();
  readonly timing: Ts7Timing;
  private readonly snapshots = new Set<Ts7SessionSnapshot>();
  private latest: Ts7SessionSnapshot | undefined;
  private paths: Ts7Paths | undefined;
  /** Whether the server speaks TypeScript 7.1's protocol (initialize). */
  private ts71 = false;
  private closed = false;

  constructor(
    private readonly rpc: Ts7RpcClient,
    collectTiming = false,
  ) {
    this.timing = new Ts7Timing(collectTiming);
  }

  ensureOpen(): void {
    if (this.closed) throw new Error("TypeScript API is closed");
  }

  binary(method: string, json: string): Uint8Array {
    this.ensureOpen();
    const payload = Buffer.from(json, "utf8");
    const start = this.timing.enabled ? performance.now() : 0;
    const bytes = this.rpc.requestBytes(method, payload);
    if (this.timing.enabled)
      this.timing.record(
        method,
        performance.now() - start,
        payload.length,
        bytes.length,
        Date.now(),
      );
    return bytes;
  }

  text(method: string, json: string): string {
    const bytes = this.binary(method, json);
    return bytes.length === 0
      ? "null"
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  }

  request<T>(method: string, query: ProgramQuery): T {
    return parseSemanticJson<T>(this.text(method, JSON.stringify(query)));
  }

  initialize(): Ts7Paths {
    this.ensureOpen();
    if (this.paths === undefined) {
      const data = parseSemanticJson<Ts7InitializeReply>(this.text("initialize", "null"));
      this.ts71 = data.caseSensitivity !== undefined;
      this.paths = new Ts7Paths(
        data.currentDirectory,
        this.ts71 ? data.caseSensitivity === 1 : data.useCaseSensitiveFileNames === true,
      );
    }
    return this.paths;
  }

  parseConfigFile(file: SemanticDocument): Ts7ConfigData {
    this.initialize();
    const data = this.request<Ts7ConfigData>("parseConfigFile", { file });
    // TypeScript 7.1 also reports the raw config, errors and compileOnSave.
    return this.ts71 ? { options: options71(data.options), fileNames: data.fileNames } : data;
  }

  /** Whether initialize found a TypeScript 7.1 server; false before it. */
  speaksTs71(): boolean {
    return this.ts71;
  }

  /** Whether the server speaks TypeScript 7.1's protocol. */
  usesTs71Protocol(): boolean {
    this.initialize();
    return this.ts71;
  }

  updateSnapshot(params: Ts7Update = {}): Ts7SessionSnapshot {
    const paths = this.initialize();
    const data = this.ts71
      ? this.snapshot71(params)
      : parseSemanticJson<Ts7ReportedSnapshotData>(
          this.text("updateSnapshot", JSON.stringify(params)),
        );
    const snapshot = new Ts7SessionSnapshot(data, this, paths);
    const previous = this.latest;
    if (previous !== undefined) {
      // Releasing the latest server snapshot also drops its change-tracking
      // baseline. A later response may omit changes even when the same
      // project's source changed, so its old cache references are not proof
      // that the new source is identical.
      if (previous.isDisposed()) this.cache.release(previous.id);
      else this.cache.retain(snapshot.id, previous.id, data.changes);
    }
    this.latest = snapshot;
    this.snapshots.add(snapshot);
    return snapshot;
  }

  /** TypeScript 7.1 derives a snapshot from a base snapshot the client
   * names (updateSnapshot), or creates the first one (createSnapshot). The
   * base is the latest snapshot: the server keeps it until the next update,
   * even after the client disposes it (release), so open projects and files
   * carry over as they do on a 7.0 server. An update lists only the projects
   * that changed; the others carry over from the base. */
  private snapshot71(params: Ts7Update): Ts7ReportedSnapshotData {
    const changes: Record<string, unknown> = {};
    if (params.openProjects !== undefined) changes["openProjects"] = params.openProjects;
    if (params.closeProjects !== undefined) changes["closeProjects"] = params.closeProjects;
    if (params.openFiles !== undefined) changes["openFiles"] = params.openFiles;
    if (params.closeFiles !== undefined) changes["closeFiles"] = params.closeFiles;
    if (params.fileChanges !== undefined) changes["fileNotifications"] = params.fileChanges;
    // A 7.1 snapshot leaves a project whose files changed dirty until asked
    // to update its program; a 7.0 snapshot's programs are always current.
    changes["ensurePrograms"] = true;
    const base = this.latest;
    const data = parseSemanticJson<Ts71SnapshotData>(
      base === undefined
        ? this.text("createSnapshot", JSON.stringify(changes))
        : this.text("updateSnapshot", JSON.stringify({ snapshot: base.id, changes })),
    );
    if (base !== undefined && base.isDisposed())
      this.binary("release", JSON.stringify({ snapshot: base.id }));
    const projects = new Map<string, Ts7ReportedProjectData>();
    const removed = new Set(data.changes?.removedProjects ?? []);
    if (base !== undefined)
      for (const project of base.projectData)
        if (!removed.has(project.id)) projects.set(project.id, project);
    for (const project of data.projects) projects.set(project.id, project71(project));
    // A changed project without a file list keeps none of its cached files.
    const changedProjects: Record<string, Ts7ProjectChangeData> = {};
    const removedProjects = [...removed];
    for (const [id, change] of Object.entries(data.changes?.changedProjects ?? {})) {
      if (change === null) removedProjects.push(id);
      else changedProjects[id] = change;
    }
    return {
      snapshot: data.snapshot,
      projects: [...projects.values()],
      changes: { changedProjects, removedProjects },
    };
  }

  release(snapshot: Ts7SessionSnapshot): void {
    this.snapshots.delete(snapshot);
    if (snapshot !== this.latest) this.cache.release(snapshot.id);
    // A 7.1 server keeps the latest snapshot as the next update's base
    // (snapshot71), which releases it after deriving from it.
    if (this.ts71 && snapshot === this.latest) return;
    this.binary("release", JSON.stringify({ snapshot: snapshot.id }));
  }

  getTimingInfo(): Ts7TimingInfo {
    this.ensureOpen();
    if (!this.timing.enabled) return this.timing.info();
    // Meta requests are intentionally absent from the client timing ring.
    const server = parseSemanticJson<Ts7ServerTiming>(this.rpc.requestText("getServerTiming", ""));
    return this.timing.info(server);
  }

  close(): void {
    if (this.closed) return;
    try {
      for (const snapshot of this.snapshots) snapshot.dispose();
    } finally {
      // Seal all object graphs even if releasing one snapshot fails because
      // the process has exited. Nothing retained may consult recycled ids.
      this.closed = true;
      for (const snapshot of this.snapshots) snapshot.invalidate();
      this.snapshots.clear();
      this.latest = undefined;
      this.cache.clear();
      this.rpc.close();
    }
  }
}

export class Ts7SessionSnapshot {
  readonly id: number;
  /** The projects as the server reported them (TypeScript 7.0's shape). */
  readonly projectData: readonly Ts7ReportedProjectData[];
  readonly semantic: SemanticSnapshot;
  private readonly projects = new Map<string, Ts7SessionProject>();
  private disposed = false;

  constructor(
    data: Ts7ReportedSnapshotData,
    private readonly session: Ts7Session,
    readonly paths: Ts7Paths,
  ) {
    this.id = data.snapshot;
    this.projectData = data.projects;
    this.semantic = new SemanticSnapshot(
      this.id,
      {
        text: (method, payload) => this.session.text(method, payload),
        binary: (method, payload) => this.session.binary(method, payload),
      },
      session.speaksTs71(),
    );
    for (const item of data.projects) {
      const project = new Ts7SessionProject(item, this, session);
      this.projects.set(paths.canonical(item.configFileName), project);
    }
  }

  ensureActive(): void {
    this.session.ensureOpen();
    if (this.disposed) throw new Error("TypeScript snapshot is disposed");
  }
  getProjects(): Ts7SessionProject[] {
    this.ensureActive();
    return [...this.projects.values()];
  }
  getProject(config: string): Ts7SessionProject | undefined {
    this.ensureActive();
    return this.projects.get(this.paths.canonical(config));
  }
  getDefaultProjectForFile(file: SemanticDocument): Ts7SessionProject | undefined {
    this.ensureActive();
    const query = { snapshot: this.id, file };
    if (this.session.usesTs71Protocol()) {
      const data = this.session.request<Ts71ProjectData | null>("getDefaultProjectForFile", query);
      return data === null ? undefined : this.getProject(project71(data).configFileName);
    }
    const data = this.session.request<Ts7ReportedProjectData | null>(
      "getDefaultProjectForFile",
      query,
    );
    return data === null ? undefined : this.getProject(data.configFileName);
  }
  isDisposed(): boolean {
    return this.disposed;
  }
  invalidate(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.semantic.dispose();
    for (const project of this.projects.values()) project.dispose();
    this.projects.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.session.release(this);
  }
}

export class Ts7SessionProject {
  readonly id: string;
  readonly configFileName: string;
  readonly compilerOptions: Ts7ProjectCompilerOptions;
  readonly rootFiles: string[];
  readonly program: Ts7SessionProgram;
  readonly checker: SemanticChecker;

  constructor(data: Ts7ReportedProjectData, snapshot: Ts7SessionSnapshot, session: Ts7Session) {
    this.id = data.id;
    this.configFileName = data.configFileName;
    this.compilerOptions = data.compilerOptions;
    this.rootFiles = data.rootFiles;
    this.program = new Ts7SessionProgram(this, snapshot, session);
    const context = snapshot.semantic.addProject(this.id, (path) =>
      this.program.getSourceFile(path),
    );
    this.checker = new SemanticChecker(context);
  }

  dispose(): void {
    this.checker.dispose();
    this.program.dispose();
  }
}

export class Ts7SessionProgram {
  private readonly sources = new Map<string, SourceFile | undefined>();
  private readonly metadata = new Map<string, Ts7SourceMetadata | undefined>();
  private disposed = false;

  constructor(
    private readonly project: Ts7SessionProject,
    private readonly snapshot: Ts7SessionSnapshot,
    private readonly session: Ts7Session,
  ) {}

  private ensureActive(): void {
    this.snapshot.ensureActive();
    if (this.disposed) throw new Error("TypeScript program is disposed");
  }
  private query(file?: SemanticDocument): ProgramQuery {
    this.ensureActive();
    return {
      snapshot: this.snapshot.id,
      project: this.project.id,
      ...(file === undefined ? {} : { file }),
    };
  }
  getCompilerOptions(): Ts7ProjectCompilerOptions {
    this.ensureActive();
    return this.project.compilerOptions;
  }
  getSourceFile(file: SemanticDocument): SourceFile | undefined {
    this.ensureActive();
    const requested = ts7DocumentFile(file);
    if (this.sources.has(requested)) return this.sources.get(requested);
    const path = this.snapshot.paths.canonical(requested);
    if (this.sources.has(path)) {
      const source = this.sources.get(path);
      this.sources.set(requested, source);
      return source;
    }
    const retained = this.session.cache.get(path, this.snapshot.id, this.project.id);
    let source = retained;
    if (source === undefined) {
      const bytes = this.session.binary("getSourceFile", JSON.stringify(this.query(file)));
      if (bytes.length !== 0) {
        const ast = new AstFile(
          bytes,
          () => {
            this.session.timing.materialized();
          },
          { writeTargets: true },
        );
        this.session.timing.fetched(Math.max(0, ast.wire.nodeCount - 2));
        source = this.session.cache.set(path, ast.sourceFile, this.snapshot.id, this.project.id);
      }
    }
    // Both successful and missing answers belong to this immutable project
    // snapshot. Later snapshots receive separate maps and shared ASTs only
    // through the content/parse-options retention cache.
    this.sources.set(path, source);
    this.sources.set(requested, source);
    return source;
  }
  getSourceFileNames(): string[] {
    return this.session.request<string[] | null>("getSourceFileNames", this.query()) ?? [];
  }
  getSourceFileMetadata(file: string): Ts7SourceMetadata | undefined {
    return this.getSourceFileMetadataByPath(this.snapshot.paths.canonical(file));
  }
  getSourceFileMetadataByPath(path: string): Ts7SourceMetadata | undefined {
    this.ensureActive();
    if (this.metadata.has(path)) return this.metadata.get(path);
    const data =
      this.session.request<Ts7SourceMetadata | null>("getSourceFileMetadata", this.query(path)) ??
      undefined;
    this.metadata.set(path, data);
    return data;
  }
  isSourceFileFromExternalLibrary(file: AstNode): boolean {
    return this.getSourceFileMetadataByPath(file.path)?.isFromExternalLibrary ?? false;
  }
  isSourceFileDefaultLibrary(file: AstNode): boolean {
    return this.getSourceFileMetadataByPath(file.path)?.isDefaultLibrary ?? false;
  }
  /** A diagnostics request for `file`, or for the whole program. TypeScript
   * 7.1 takes the file in a list (`files`). */
  private diagnosticsQuery(file?: SemanticDocument): ProgramQuery {
    if (file === undefined || !this.session.usesTs71Protocol()) return this.query(file);
    const query = this.query();
    query.files = [file];
    return query;
  }
  private diagnostics(method: string, file?: SemanticDocument): Ts7Diagnostic[] {
    const result: Ts7Diagnostic[] = [];
    for (const data of this.session.request<Ts7DiagnosticData[] | null>(
      method,
      this.diagnosticsQuery(file),
    ) ?? [])
      result.push(ts7Diagnostic(data));
    return result;
  }
  /** The diagnostics of `method` for `file`, or for the whole program, as
   * the server sends them. */
  diagnosticData(method: string, file?: SemanticDocument): Ts7DiagnosticData[] {
    return (
      this.session.request<Ts7DiagnosticData[] | null>(method, this.diagnosticsQuery(file)) ?? []
    );
  }
  /** The semantic diagnostics of each of `files` and the global diagnostics,
   * after the server checks only those files (getDiagnosticsOfCheckedFiles),
   * or null when the server does not answer that method. */
  checkedFileDiagnosticData(files: readonly string[]): Ts7CheckedFileDiagnosticData | null {
    try {
      return this.session.request<Ts7CheckedFileDiagnosticData>("getDiagnosticsOfCheckedFiles", {
        ...this.query(),
        files: [...files],
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('unknown API method "getDiagnosticsOfCheckedFiles"')
      )
        return null;
      throw error;
    }
  }
  getSyntacticDiagnostics(file?: SemanticDocument): Ts7Diagnostic[] {
    return this.diagnostics("getSyntacticDiagnostics", file);
  }
  getBindDiagnostics(file?: SemanticDocument): Ts7Diagnostic[] {
    return this.diagnostics("getBindDiagnostics", file);
  }
  getSemanticDiagnostics(file?: SemanticDocument): Ts7Diagnostic[] {
    return this.diagnostics("getSemanticDiagnostics", file);
  }
  getSuggestionDiagnostics(file?: SemanticDocument): Ts7Diagnostic[] {
    return this.diagnostics("getSuggestionDiagnostics", file);
  }
  getDeclarationDiagnostics(file?: SemanticDocument): Ts7Diagnostic[] {
    return this.diagnostics("getDeclarationDiagnostics", file);
  }
  getProgramDiagnostics(): Ts7Diagnostic[] {
    return this.diagnostics("getProgramDiagnostics");
  }
  getGlobalDiagnostics(): Ts7Diagnostic[] {
    return this.diagnostics("getGlobalDiagnostics");
  }
  getConfigFileParsingDiagnostics(): Ts7Diagnostic[] {
    return this.diagnostics("getConfigFileParsingDiagnostics");
  }
  dispose(): void {
    this.disposed = true;
    this.sources.clear();
    this.metadata.clear();
  }
}
