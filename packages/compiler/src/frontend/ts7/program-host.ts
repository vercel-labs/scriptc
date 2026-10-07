import { ProgramAnalysis } from "../program-analysis.js";
import { InternalCompilerError } from "../../errors.js";
/* Shared program lifecycle over the native TypeScript server API.
 *
 * 7.0.2 has no createProgram(roots, options): the model is
 * new API({cwd, fs}) -> updateSnapshot({openProjects: [tsconfig]}) ->
 * snapshot.getProject(...), strictly tsconfig-driven. scriptc's no-tsconfig /
 * extra-roots story (entry + ambient dts + fallback/overrides dts, forced
 * options) maps onto that through a SYNTHESIZED IN-MEMORY tsconfig: the
 * virtual-FS hooks serve one nonexistent tsconfig path whose "files" lists
 * exactly our roots (absolute paths) and whose compilerOptions serialize our
 * options; every other path falls through to the real filesystem, so real
 * entries, ambient .d.ts files, and node_modules resolve exactly as on disk.
 *
 * One Ts7Host owns one server connection. Its API factory selects the
 * process transport; program and filesystem behavior is shared by the Node
 * and statically compiled clients. */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ts7Api } from "./api.js";
import type { Ts7TimingInfo } from "./session-timing.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";
import type { CompilerOptions, Diagnostic } from "./semantic-types.js";
import type { SourceFile } from "./ast-types.js";
import type { Ts7SessionProject as Project, Ts7SessionSnapshot as Snapshot } from "./session.js";
import { CheckerFacade } from "./checker.js";
import {
  moduleDetectionKindName,
  moduleKindName,
  moduleResolutionKindName,
  scriptTargetName,
  ScriptTarget,
} from "./enums.js";
import { tsgoPath } from "./session-path.js";
import {
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
  trackedRealpath,
} from "../input-tracker.js";

/** The compiler options our createProgram accepts: TS7's CompilerOptions
 * shape (numeric enums for target/module/moduleResolution — the enums module
 * generates them from the pinned SDK) with the 5.9.3 "lib.es2025.d.ts" lib
 * spelling also accepted. */
export type Ts7CompilerOptions = CompilerOptions;

/* tsconfig JSON wants enum NAMES; the options object carries TS7's numeric
 * enum values. Generated name lookups preserve the SDK's reverse mappings
 * without materializing enum objects in the native compiler. */
function serializeOptions(options: Ts7CompilerOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    switch (key) {
      // tsgo's tsconfig parser is case-sensitive about enum-option spellings
      // (5.9.3's was not): the enum KEY names lowercase to the accepted forms
      // ("ESNext" -> "esnext", "Bundler" -> "bundler", "NodeNext" ->
      // "nodenext").
      case "target":
        // ScriptTarget.ESNext and .Latest share a value; the reverse map
        // answers "Latest", which the option parser does not accept.
        out[key] =
          value === ScriptTarget.ESNext
            ? "esnext"
            : (scriptTargetName(value as number)?.toLowerCase() ?? value);
        break;
      case "module":
        out[key] = moduleKindName(value as number)?.toLowerCase() ?? value;
        break;
      case "moduleResolution":
        out[key] = moduleResolutionKindName(value as number)?.toLowerCase() ?? value;
        break;
      case "moduleDetection":
        out[key] = moduleDetectionKindName(value as number)?.toLowerCase() ?? value;
        break;
      case "lib":
        // 5.9.3 spells lib entries "lib.es2025.d.ts"; tsconfig wants "es2025".
        out[key] = (value as string[]).map((lib) =>
          lib.startsWith("lib.") && lib.endsWith(".d.ts") ? lib.slice(4, -5) : lib,
        );
        break;
      default: {
        if (typeof value === "number" && key !== "maxNodeModuleJsDepth") {
          throw new InternalCompilerError(
            `ts7 createProgram: unhandled enum-valued compiler option '${key}'`,
          );
        }
        out[key] = value;
      }
    }
  }
  return out;
}

/** TypeScript's filesystem reader removes a leading UTF-8 BOM before the
 * parser sees source text. node:fs's utf8 reader keeps it, so normalize every
 * virtual, shadowed, and real host response to the same parser contract. */
function stripSourceBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

let nextConfigId = 0;

export interface Ts7ApiOptions {
  cwd: string;
  fs: Ts7FileSystem;
  collectTiming: boolean;
}

export type Ts7ApiFactory = (options: Ts7ApiOptions) => Ts7Api;

export type Ts7HostOptions = {
  cwd?: string;
  collectTiming?: boolean;
  /** Optional real-path shadow (the --npm-static resolution lever):
   * `readFile` may answer REPLACEMENT content for a real file (a
   * types-stripped package.json) and `hideFile` may shadow a real file
   * out of existence (an opted-in package's shipped .d.ts). Virtual
   * files always win; unshadowed paths fall through to the real FS. */
  fsShadow?: {
    readFile: (path: string) => string | undefined;
    hideFile: (path: string) => boolean;
  } | null;
};

/** One spawned tsgo server plus the virtual-FS overlay serving synthesized
 * tsconfigs. Share a host across programs to pay the spawn once; the overlay
 * is a live map, so each createProgram call adds its config before taking
 * the snapshot. */
export class Ts7Host {
  private readonly virtualFiles = new Map<string, string>();
  private readonly virtualChanges = new Map<string, "created" | "changed">();
  private readonly closingProjects = new Set<string>();
  private readonly api: Ts7Api;
  private closed = false;

  constructor(createApi: Ts7ApiFactory, options?: Ts7HostOptions) {
    const virtualFiles = this.virtualFiles;
    const shadow = options?.fsShadow ?? null;
    this.api = createApi({
      cwd: options?.cwd ?? process.cwd(),
      collectTiming: options?.collectTiming ?? false,
      fs: {
        // string => virtual (or shadowed) hit; null => shadowed out of
        // existence; undefined => real-FS fallthrough.
        readFile: (fileName) => {
          const virtual = virtualFiles.get(tsgoPath(fileName));
          if (virtual !== undefined) return stripSourceBom(virtual);
          if (shadow !== null) {
            if (shadow.hideFile(fileName)) return null;
            const replacement = shadow.readFile(fileName);
            if (replacement !== undefined) return stripSourceBom(replacement);
          }
          const source = trackedReadFile(fileName);
          return source === null ? null : stripSourceBom(source);
        },
        fileExists: (fileName) => {
          if (virtualFiles.has(tsgoPath(fileName))) return true;
          if (shadow !== null && shadow.hideFile(fileName)) return false;
          return trackedFileExists(fileName);
        },
        directoryExists: (path) => trackedDirectoryExists(path),
        realpath: (path) =>
          virtualFiles.has(tsgoPath(path)) ? path : (trackedRealpath(path) ?? path),
        getAccessibleEntries: (path) =>
          trackedAccessibleEntries(path) ?? { files: [], directories: [] },
      },
    });
  }

  /** Registers an in-memory file served to tsgo by the virtual-FS hooks. */
  addVirtualFile(path: string, content: string): void {
    this.ensureOpen();
    const key = tsgoPath(path);
    if (this.virtualFiles.get(key) === content) return;
    if (!this.virtualChanges.has(key))
      this.virtualChanges.set(key, this.virtualFiles.has(key) ? "changed" : "created");
    this.virtualFiles.set(key, content);
  }

  /** tsgo's own tsconfig parser (extends chains resolved server-side) — the
   * 7-world replacement for ts.readConfigFile + ts.parseJsonConfigFileContent.
   * Returns raw option values (strings for enum-ish knobs) and the resolved
   * file list. */
  parseConfigFile(configPath: string): { options: Record<string, unknown>; fileNames: string[] } {
    this.ensureOpen();
    return this.api.parseConfigFile(resolve(configPath));
  }

  createProgram(
    rootNames: readonly string[],
    options: Ts7CompilerOptions,
    /** Internal: true when the program owns this host and dispose() closes it. */
    programOwnsHost = false,
  ): Ts7Program {
    this.ensureOpen();
    const roots = rootNames.map((r) => resolve(r));
    const first = roots[0];
    if (first === undefined) throw new InternalCompilerError("ts7 createProgram: no root files");
    const configPath = join(dirname(first), `__scriptc-ts7-${nextConfigId++}.tsconfig.json`);
    this.virtualFiles.set(
      tsgoPath(configPath),
      JSON.stringify({ compilerOptions: serializeOptions(options), files: roots, include: [] }),
    );
    const created: string[] = [];
    const changed: string[] = [];
    const closeProjects: string[] = [...this.closingProjects];
    for (const [path, kind] of this.virtualChanges) {
      if (kind === "created") created.push(path);
      else changed.push(path);
    }
    try {
      const snapshot = this.api.updateSnapshot({
        openProjects: [configPath],
        closeProjects,
        fileChanges: { created, changed },
      });
      this.closingProjects.clear();
      this.virtualChanges.clear();
      const project = snapshot.getProject(configPath);
      if (!project) {
        snapshot.dispose();
        throw new InternalCompilerError(`ts7 createProgram: project failed to open for ${first}`);
      }
      return new Ts7Program(project, snapshot, this, !programOwnsHost, configPath);
    } catch (error) {
      this.releaseProgram(configPath);
      throw error;
    }
  }

  /** Retire a synthesized config when its program no longer needs it.
   * The next update closes its project without disturbing older snapshots
   * still owned by other programs sharing this connection. */
  releaseProgram(configPath: string): void {
    this.virtualFiles.delete(tsgoPath(configPath));
    if (!this.closed) this.closingProjects.add(configPath);
  }

  getTimingInfo(): Ts7TimingInfo {
    this.ensureOpen();
    return this.api.getTimingInfo();
  }

  private ensureOpen(): void {
    if (this.closed) throw new InternalCompilerError("Ts7Host is closed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.api.close();
    } finally {
      this.virtualFiles.clear();
      this.virtualChanges.clear();
      this.closingProjects.clear();
    }
  }
}

/** ts.Program-shaped facade over a TS7 Project: same-name query surface plus
 * getTypeChecker() returning the memoizing/batching CheckerFacade. dispose()
 * releases the snapshot (and the host, when this program spawned it). */
export class Ts7Program {
  readonly analysis = new ProgramAnalysis();
  private sourceFilesCache: readonly SourceFile[] | null = null;
  private implementationFilesCache: readonly SourceFile[] | null = null;
  private sourceFileNamesCache: readonly string[] | null = null;
  private checkerFacade: CheckerFacade | null = null;
  private disposed = false;

  constructor(
    /** The underlying TS7 project (program + checker + emitter). */
    readonly project: Project,
    private readonly snapshot: Snapshot,
    private readonly host: Ts7Host,
    private readonly sharedHost: boolean,
    private readonly configPath: string,
  ) {}

  getCompilerOptions(): CompilerOptions {
    return this.project.program.getCompilerOptions();
  }

  getSourceFile(fileName: string): SourceFile | undefined {
    return this.project.program.getSourceFile(resolve(fileName));
  }

  getSourceFileNames(): readonly string[] {
    this.snapshot.ensureActive();
    return (this.sourceFileNamesCache ??= this.project.program.getSourceFileNames());
  }

  /** Runtime discovery needs implementation trees, while tsgo still checks
   * the whole program. Skip conventional declaration names before asking
   * for their ASTs; unusual declaration extensions retain the checked path.
   * Declaration lookup and getSourceFiles() remain available on demand. */
  getImplementationSourceFiles(): readonly SourceFile[] {
    this.snapshot.ensureActive();
    if (this.implementationFilesCache === null) {
      const files: SourceFile[] = [];
      for (const name of this.getSourceFileNames()) {
        if (name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts")) continue;
        const file = this.getSourceFile(name);
        if (file !== undefined && !file.isDeclarationFile) files.push(file);
      }
      this.implementationFilesCache = files;
    }
    return this.implementationFilesCache;
  }

  /** Materializes every file of the program (5.9.3's getSourceFiles shape).
   * 7.0.2 serves files one by one; the result is cached, so the full-program
   * sweeps (preflight's user-file scan) pay the transfer once. */
  getSourceFiles(): readonly SourceFile[] {
    this.snapshot.ensureActive();
    if (this.sourceFilesCache === null) {
      const program = this.project.program;
      const files: SourceFile[] = [];
      for (const name of this.getSourceFileNames()) {
        const file = program.getSourceFile(name);
        if (file !== undefined) files.push(file);
      }
      this.sourceFilesCache = files;
    }
    return this.sourceFilesCache;
  }

  getTypeChecker(): CheckerFacade {
    this.snapshot.ensureActive();
    if (this.checkerFacade === null)
      this.checkerFacade = new CheckerFacade(this.project.checker, {
        project: this.project.checker.project,
      });
    return this.checkerFacade;
  }

  getSyntacticDiagnostics(sourceFile?: SourceFile): readonly Diagnostic[] {
    return this.project.program.getSyntacticDiagnostics(sourceFile?.fileName);
  }

  getSemanticDiagnostics(sourceFile?: SourceFile): readonly Diagnostic[] {
    return this.project.program.getSemanticDiagnostics(sourceFile?.fileName);
  }

  getGlobalDiagnostics(): readonly Diagnostic[] {
    return this.project.program.getGlobalDiagnostics();
  }

  getProgramDiagnostics(): readonly Diagnostic[] {
    return this.project.program.getProgramDiagnostics();
  }

  getConfigFileParsingDiagnostics(): readonly Diagnostic[] {
    return this.project.program.getConfigFileParsingDiagnostics();
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileDefaultLibrary(file);
  }

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileFromExternalLibrary(file);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.analysis.clear();
    this.checkerFacade?.dispose();
    this.checkerFacade = null;
    this.sourceFilesCache = null;
    this.implementationFilesCache = null;
    this.sourceFileNamesCache = null;
    try {
      this.snapshot.dispose();
    } finally {
      this.host.releaseProgram(this.configPath);
      if (!this.sharedHost) this.host.close();
    }
  }
}

/** 5.9.3's getPreEmitDiagnostics, composed from 7.0.2's split surface (the
 * package dropped the aggregate). Order mirrors 5.9.3: config, options/
 * program, global, syntactic, semantic. */
export function getPreEmitDiagnostics(program: Ts7Program): readonly Diagnostic[] {
  return [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
}

/** ts.findConfigFile: nearest configName walking up from searchPath. */
export function findConfigFile(
  searchPath: string,
  fileExists: (fileName: string) => boolean = sys.fileExists,
  configName = "tsconfig.json",
): string | undefined {
  let dir = resolve(searchPath);
  for (;;) {
    const candidate = join(dir, configName);
    if (fileExists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The frontend's ts.sys subset, implemented with filesystem and process
 * operations supported by both the Node and native compiler hosts. */
export const sys = {
  fileExists(path: string): boolean {
    return trackedFileExists(path);
  },
  readFile(path: string): string | undefined {
    return trackedReadFile(path) ?? undefined;
  },
  writeFile(path: string, data: string): void {
    writeFileSync(path, data);
  },
  directoryExists(path: string): boolean {
    return trackedDirectoryExists(path);
  },
  getCurrentDirectory(): string {
    return process.cwd();
  },
  useCaseSensitiveFileNames: true,
  newLine: "\n",
};
