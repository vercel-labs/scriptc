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

/** Source text, in UTF-16 code units, whose parse results one parser
 * retains. A build asks the parser about the same files over and over (every
 * npm-static rung and island round re-reads the same package sources, and one
 * read is rewritten several ways), so a hit answers a parse that already
 * happened. Parsing a source is a pure function of its path and text, and the
 * result is a detached, immutable AST. The bound keeps the retained trees —
 * roughly ten times their text — small next to a compile's heap. */
const PARSED_SOURCE_BUDGET = 32 * 1024 * 1024;

interface ParsedSource {
  source: string;
  file: SourceFile;
}

/** A syntax-only session with a closed, in-memory filesystem. Parsing a
 * source string never reads imports, project configuration, or libraries
 * from disk. The returned AST owns its wire data and outlives the session.
 * Only one project and one input are retained between requests, and the
 * parse cache answers the sources this parser already parsed. */
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
  /** Results by path and exact source text, oldest first. */
  private readonly parsed = new Map<string, ParsedSource[]>();
  /** One path per retained result, in the order the results were retained.
   * A path parsed again appears once per retained result, so the head of
   * this queue names the path of the oldest retained result. */
  private readonly retentionOrder: string[] = [];
  private retainedSource = 0;

  constructor(
    createApi: Ts7SourceApiFactory,
    cwd = process.cwd(),
    private readonly sourceBudget = SERVER_SOURCE_BUDGET,
    private readonly parsedSourceBudget = PARSED_SOURCE_BUDGET,
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
    const retained = this.retained(path, source);
    if (retained !== undefined) return retained;
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
      this.retain(path, source, file);
      return file;
    } finally {
      snapshot.dispose();
    }
  }

  /** The result an earlier parse of this path and text made, if retained. */
  private retained(path: string, source: string): SourceFile | undefined {
    for (const entry of this.parsed.get(path) ?? []) if (entry.source === source) return entry.file;
    return undefined;
  }

  /** Retains one parse result, evicting the oldest ones past the source
   * budget. The server budget counts misses only: a retained source is
   * never parsed again, so it never grows a server. */
  private retain(path: string, source: string, file: SourceFile): void {
    let entries = this.parsed.get(path);
    if (entries === undefined) this.parsed.set(path, (entries = []));
    entries.push({ source, file });
    this.retentionOrder.push(path);
    this.retainedSource += source.length;
    // The newest result can put the retained source over the budget by more
    // than the oldest result holds, so keep evicting, oldest first, until it
    // is within the budget again; one eviction per path is not enough when a
    // path has several retained versions.
    while (this.retainedSource > this.parsedSourceBudget) {
      const oldest = this.retentionOrder.shift();
      if (oldest === undefined) break;
      const list = this.parsed.get(oldest);
      const gone = list?.shift();
      if (list === undefined || gone === undefined) continue;
      this.retainedSource -= gone.source.length;
      if (list.length === 0) this.parsed.delete(oldest);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.files.clear();
    this.parsed.clear();
    this.retentionOrder.length = 0;
    this.retainedSource = 0;
    this.previousPath = undefined;
    this.previousText = undefined;
    this.previousFile = undefined;
    this.api.close();
  }
}
