import { InternalCompilerError } from "../../errors.js";
/* Program lifecycle over typescript@7.0.2's unstable sync API — the
 * ts.createProgram-shaped entry the survey's probe7b proved out.
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
 * One Ts7Host owns one spawned tsgo server (54 ms warm spawn per the survey;
 * 387 cold). createProgram() takes an optional shared host — the default
 * spawns a private one that dispose() closes. */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import type {
  CompilerOptions,
  Diagnostic,
  Project,
  Snapshot,
} from "typescript/unstable/sync";
import type { SourceFile } from "typescript/unstable/ast";
import { CheckerFacade } from "./checker.js";
import { enumKeyOf, ModuleDetectionKind, ModuleKind, ModuleResolutionKind, ScriptTarget } from "./enums.js";
import { tsgoPath } from "../dts-paths.js";
import { trackedAccessibleEntries, trackedDirectoryExists, trackedFileExists, trackedReadFile, trackedRealpath } from "../input-tracker.js";

/** The compiler options our createProgram accepts: TS7's CompilerOptions
 * shape (numeric enums for target/module/moduleResolution — the enums module
 * re-exports them symbolically) with the 5.9.3 "lib.es2025.d.ts" lib
 * spelling also accepted. */
export type Ts7CompilerOptions = CompilerOptions;

/* tsconfig JSON wants enum NAMES; the options object carries TS7's numeric
 * enum values. The names come from the enum objects' own reverse mappings —
 * nothing here knows a number. */
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
            : (enumKeyOf(ScriptTarget as never, value as number)?.toLowerCase() ?? value);
        break;
      case "module":
        out[key] = enumKeyOf(ModuleKind as never, value as number)?.toLowerCase() ?? value;
        break;
      case "moduleResolution":
        out[key] = enumKeyOf(ModuleResolutionKind as never, value as number)?.toLowerCase() ?? value;
        break;
      case "moduleDetection":
        out[key] = enumKeyOf(ModuleDetectionKind as never, value as number)?.toLowerCase() ?? value;
        break;
      case "lib":
        // 5.9.3 spells lib entries "lib.es2025.d.ts"; tsconfig wants "es2025".
        out[key] = (value as string[]).map((lib) =>
          lib.startsWith("lib.") && lib.endsWith(".d.ts") ? lib.slice(4, -5) : lib,
        );
        break;
      default: {
        if (typeof value === "number" && key !== "maxNodeModuleJsDepth") {
          throw new InternalCompilerError(`ts7 createProgram: unhandled enum-valued compiler option '${key}'`);
        }
        out[key] = value;
      }
    }
  }
  return out;
}

let nextConfigId = 0;

/** One spawned tsgo server plus the virtual-FS overlay serving synthesized
 * tsconfigs. Share a host across programs to pay the spawn once; the overlay
 * is a live map, so each createProgram call adds its config before taking
 * the snapshot. */
export class Ts7Host {
  private readonly virtualFiles = new Map<string, string>();
  private readonly api: API;
  private closed = false;

  constructor(options?: {
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
  }) {
    const virtualFiles = this.virtualFiles;
    const shadow = options?.fsShadow ?? null;
    this.api = new API({
      cwd: options?.cwd ?? process.cwd(),
      ...(options?.collectTiming !== undefined ? { collectTiming: options.collectTiming } : {}),
      fs: {
        // string => virtual (or shadowed) hit; null => shadowed out of
        // existence; undefined => real-FS fallthrough.
        readFile: (fileName) => {
          const virtual = virtualFiles.get(tsgoPath(fileName));
          if (virtual !== undefined) return virtual;
          if (shadow !== null) {
            if (shadow.hideFile(fileName)) return null;
            const replacement = shadow.readFile(fileName);
            if (replacement !== undefined) return replacement;
          }
          return trackedReadFile(fileName);
        },
        fileExists: (fileName) => {
          if (virtualFiles.has(tsgoPath(fileName))) return true;
          if (shadow !== null && shadow.hideFile(fileName)) return false;
          return trackedFileExists(fileName);
        },
        directoryExists: (path) => trackedDirectoryExists(path),
        realpath: (path) =>
          virtualFiles.has(tsgoPath(path)) ? path : (trackedRealpath(path) ?? path),
        getAccessibleEntries: (path) => trackedAccessibleEntries(path) ?? { files: [], directories: [] },
      },
    });
  }

  /** Registers an in-memory file served to tsgo by the virtual-FS hooks. */
  addVirtualFile(path: string, content: string): void {
    this.virtualFiles.set(tsgoPath(path), content);
  }

  /** tsgo's own tsconfig parser (extends chains resolved server-side) — the
   * 7-world replacement for ts.readConfigFile + ts.parseJsonConfigFileContent.
   * Returns raw option values (strings for enum-ish knobs) and the resolved
   * file list. */
  parseConfigFile(configPath: string): { options: Record<string, unknown>; fileNames: string[] } {
    return this.api.parseConfigFile(resolve(configPath));
  }

  createProgram(
    rootNames: readonly string[],
    options: Ts7CompilerOptions,
    /** Internal: true when the program owns this host and dispose() closes it. */
    programOwnsHost = false,
  ): Ts7Program {
    if (this.closed) throw new InternalCompilerError("Ts7Host is closed");
    const roots = rootNames.map((r) => resolve(r));
    const first = roots[0];
    if (first === undefined) throw new InternalCompilerError("ts7 createProgram: no root files");
    const configPath = join(dirname(first), `__scriptc-ts7-${nextConfigId++}.tsconfig.json`);
    this.addVirtualFile(
      configPath,
      JSON.stringify({ compilerOptions: serializeOptions(options), files: roots, include: [] }),
    );
    const snapshot = this.api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    if (!project) {
      snapshot.dispose();
      throw new InternalCompilerError(`ts7 createProgram: project failed to open for ${first}`);
    }
    return new Ts7Program(project, snapshot, this, !programOwnsHost);
  }

  getTimingInfo(): unknown {
    return this.api.getTimingInfo();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.api.close();
  }
}

/** ts.Program-shaped facade over a TS7 Project: same-name query surface plus
 * getTypeChecker() returning the memoizing/batching CheckerFacade. dispose()
 * releases the snapshot (and the host, when this program spawned it). */
export class Ts7Program {
  private sourceFilesCache: readonly SourceFile[] | null = null;
  private checkerFacade: CheckerFacade | null = null;

  constructor(
    /** The underlying TS7 project (program + checker + emitter). */
    readonly project: Project,
    private readonly snapshot: Snapshot,
    private readonly host: Ts7Host,
    private readonly sharedHost: boolean,
  ) {}

  getCompilerOptions(): CompilerOptions {
    return this.project.program.getCompilerOptions();
  }

  getSourceFile(fileName: string): SourceFile | undefined {
    return this.project.program.getSourceFile(resolve(fileName));
  }

  getSourceFileNames(): readonly string[] {
    return this.project.program.getSourceFileNames();
  }

  /** Materializes every file of the program (5.9.3's getSourceFiles shape).
   * 7.0.2 serves files one by one; the result is cached, so the full-program
   * sweeps (preflight's user-file scan) pay the transfer once. */
  getSourceFiles(): readonly SourceFile[] {
    if (this.sourceFilesCache === null) {
      const program = this.project.program;
      this.sourceFilesCache = program
        .getSourceFileNames()
        .map((name) => program.getSourceFile(name))
        .filter((sf): sf is SourceFile => sf !== undefined);
    }
    return this.sourceFilesCache;
  }

  getTypeChecker(): CheckerFacade {
    this.checkerFacade ??= new CheckerFacade(this.project.checker, { project: this.project });
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
    this.snapshot.dispose();
    if (!this.sharedHost) this.host.close();
  }
}

/** The ts.createProgram-shaped entry: roots + options, tsconfig synthesized
 * behind the scenes. Without a shared host each call spawns (and owns) its
 * own tsgo server — pass one Ts7Host when building several programs (the
 * lowering world and preflight's project world). */
export function createProgram(
  rootNames: readonly string[],
  options: Ts7CompilerOptions,
  host?: Ts7Host,
): Ts7Program {
  if (host) return host.createProgram(rootNames, options);
  const first = rootNames[0];
  const owned = new Ts7Host({ cwd: first !== undefined ? dirname(resolve(first)) : process.cwd() });
  return owned.createProgram(rootNames, options, /* programOwnsHost */ true);
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

/** The ts.sys subset the census uses (program.ts, npm.ts — 8 call sites),
 * over node:fs. 7.0.2 ships no ts.sys; the compiler runs on Node, so these
 * are the direct implementations. */
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
