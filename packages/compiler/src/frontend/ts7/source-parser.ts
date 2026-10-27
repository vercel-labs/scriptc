import { resolve } from "node:path";
import type { SourceFile } from "./ast-types.js";
import { Ts7Api } from "./api.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";
import { tsgoPath } from "./session-path.js";

export type Ts7SourceKind = "js" | "jsx" | "ts" | "tsx";
export type Ts7SourceApiFactory = (options: { cwd: string; fs: Ts7FileSystem }) => Ts7Api;

/** The source text, in UTF-16 code units, one parser server parses before a
 * new server replaces it. tsc-ts keeps the syntax trees it builds for the
 * life of its process, so a server that parses many files grows with them; a
 * new one starts empty. Results are detached ASTs and outlive the server that
 * made them. */
const SERVER_SOURCE_BUDGET = 256 * 1024;

/** A syntax-only session with a closed, in-memory filesystem. Parsing a
 * source string never reads imports, project configuration, or libraries
 * from disk. The returned AST owns its wire data and outlives the session.
 * Only one project and one input are retained between requests. */
export class Ts7SourceParser {
  private api: Ts7Api;
  private readonly createApi: Ts7SourceApiFactory;
  private parsedSource = 0;
  private readonly files = new Map<string, string>();
  private readonly configPath: string;
  private previousPath: string | undefined;
  private previousText: string | undefined;
  private previousFile: SourceFile | undefined;
  private closed = false;
  private readonly cwd: string;

  constructor(
    createApi: Ts7SourceApiFactory,
    cwd = process.cwd(),
    private readonly sourceBudget = SERVER_SOURCE_BUDGET,
  ) {
    this.cwd = resolve(cwd);
    this.configPath = tsgoPath(resolve(this.cwd, "__scriptc-source-parser.tsconfig.json"));
    this.createApi = createApi;
    this.api = this.connect();
  }

  private connect(): Ts7Api {
    // Called as a plain function: the instance is not its receiver.
    const createApi = this.createApi;
    return createApi({
      cwd: this.cwd,
      fs: {
        readFile: (path) => this.files.get(tsgoPath(path)) ?? null,
        fileExists: (path) => this.files.has(tsgoPath(path)),
        directoryExists: (path) => {
          const directory = tsgoPath(path);
          for (const file of this.files.keys()) {
            if (file.startsWith(directory.endsWith("/") ? directory : directory + "/")) return true;
          }
          return false;
        },
        realpath: (path) => path,
        getAccessibleEntries: () => ({ files: [], directories: [] }),
      },
    });
  }

  parse(fileName: string, source: string, kind: Ts7SourceKind): SourceFile {
    if (this.closed) throw new Error("TypeScript source parser is closed");
    // The native parser selects its grammar from the extension. Preserve a
    // matching source name, including declaration and module suffixes.
    const extensionMatches =
      kind === "ts"
        ? /\.(?:[cm]?ts)$/.test(fileName)
        : kind === "js"
          ? /\.(?:[cm]?js)$/.test(fileName)
          : fileName.endsWith("." + kind);
    const path = tsgoPath(resolve(this.cwd, extensionMatches ? fileName : fileName + "." + kind));
    if (path === this.configPath)
      throw new Error("source path conflicts with the parser configuration");
    if (
      path === this.previousPath &&
      source === this.previousText &&
      this.previousFile !== undefined
    )
      return this.previousFile;
    let previousPath = this.previousPath;
    if (this.parsedSource >= this.sourceBudget) {
      this.api.close();
      this.api = this.connect();
      this.parsedSource = 0;
      previousPath = undefined;
    }
    this.parsedSource += source.length;
    this.files.clear();
    this.files.set(path, source);
    this.files.set(
      this.configPath,
      JSON.stringify({
        compilerOptions: {
          target: "esnext",
          module: "esnext",
          jsx: "preserve",
          allowJs: true,
          noResolve: true,
          noLib: true,
          types: [],
          noEmit: true,
        },
        files: [path],
        include: [],
      }),
    );
    // Invalidate the bounded project instead of retaining every source path
    // ever parsed. A previous result remains a detached, immutable AST.
    const snapshot = this.api.updateSnapshot({
      openProjects: [this.configPath],
      fileChanges: {
        changed: [this.configPath, path],
        created: previousPath === path ? [] : [path],
        deleted: previousPath !== undefined && previousPath !== path ? [previousPath] : [],
      },
    });
    try {
      const project = snapshot.getProject(this.configPath);
      const file = project?.program.getSourceFile(path);
      if (file === undefined) throw new Error(`could not parse source file ${fileName}`);
      this.previousPath = path;
      this.previousText = source;
      this.previousFile = file;
      return file;
    } finally {
      snapshot.dispose();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.files.clear();
    this.previousPath = undefined;
    this.previousText = undefined;
    this.previousFile = undefined;
    this.api.close();
  }
}
