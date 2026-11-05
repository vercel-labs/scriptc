/* Flow sources (a project's `scriptc.flow` setting): `.js` modules with a
 * `@flow` or `@noflow` pragma, or every `.js` module with `"all": true`
 * (none under node_modules), compile as the TypeScript they translate to
 * (translate.ts).
 *
 * A Flow module `m.js` is presented as `m.ts`, or `m.tsx` when it holds
 * JSX: the program serves the translation at that path and hides the `.js`
 * file, so the checker and scriptc's resolver (resolve.ts normalizes every
 * answer through flowPresentedPath) treat it as TypeScript, and `./m.js`
 * specifiers resolve to it as they do to any TypeScript source. Runtime
 * fence messages name the Flow source and line (fenceLocation), and a
 * module that does not translate is a diagnostic at its Flow source
 * (flowTranslationFailures). Other diagnostics still name the presented
 * path.
 *
 * Nothing here runs unless a load enables Flow: without the setting, no
 * file is read for a pragma and every hook answers immediately. */
import { applySourceEdits, type EditedSource } from "../source-edits.js";
import { unsupportedDiag, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { FlowTranslateError, translateFlow, type FlowNode } from "./translate.js";

export type { FlowNode } from "./translate.js";

/** A project's Flow settings (package.json `scriptc.flow`). */
interface FlowOptions {
  /** Type names that compile as `unknown`: values the project keeps
   * checked-dynamic. */
  dynamicTypes?: readonly string[];
  /** Type names whose Flow type the project corrects, as the TypeScript
   * type they compile as (`{ "Key": "symbol" }` for a symbol
   * Flow is told is `true`). */
  types?: Readonly<Record<string, string>>;
  /** Every project `.js` module is a Flow module, pragma or not (Flow's
   * own `all=true` option). */
  all?: boolean;
  /** The project's compile-time constants (`scriptc.constants`). */
  constants?: ReadonlyMap<string, boolean | number | string | null>;
}

/** Parses a Flow module (hermes-parser's ESTree, with ranges). */
export type FlowParser = (text: string) => FlowNode;

interface FlowModule {
  /** The Flow source file. */
  flowPath: string;
  /** The Flow source text. */
  source: string;
  translation: EditedSource;
}

/** The leading comments hold `@flow` or `@noflow`: either way the module
 * is written in Flow's syntax (`@noflow` only opts out of checking). */
export function hasFlowPragma(text: string): boolean {
  const head = /^(?:\s|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/|#![^\n]*\n)*/.exec(text)?.[0] ?? "";
  // `@flow`, `@flow strict`, `@noflow`; not `@flowtype` or `@flow.org`.
  return /@(?:no)?flow(?![\w.@-])/.test(head);
}

class FlowLayer {
  private readonly pragma = new Map<string, boolean>();
  private readonly parsed = new Map<string, { ast: FlowNode } | { error: unknown }>();
  private readonly presented = new Map<string, string | null>();
  private readonly modules = new Map<string, FlowModule>();
  private readonly types: ReadonlyMap<string, string>;
  private readonly constants: ReadonlyMap<string, boolean | number | string | null>;
  private readonly all: boolean;
  /** The modules that did not translate, with their Flow source text. */
  readonly failures: { diagnostic: ScrDiagnostic; text: string }[] = [];

  constructor(
    private readonly parse: FlowParser,
    options: FlowOptions,
    private readonly read: (path: string) => string | null,
    private readonly exists: (path: string) => boolean,
  ) {
    this.types = new Map([
      ...(options.dynamicTypes ?? []).map((name): [string, string] => [name, "unknown"]),
      ...Object.entries(options.types ?? {}),
    ]);
    this.constants = options.constants ?? new Map();
    this.all = options.all === true;
  }

  isFlowFile(path: string): boolean {
    if (!path.endsWith(".js") || path.includes("/node_modules/")) return false;
    let flow = this.pragma.get(path);
    if (flow === undefined) {
      const text = this.read(path);
      // A TypeScript file beside it keeps its own path.
      const base = path.slice(0, -3);
      flow =
        text !== null &&
        (this.all || hasFlowPragma(text)) &&
        !this.exists(base + ".ts") &&
        !this.exists(base + ".tsx");
      this.pragma.set(path, flow);
    }
    return flow;
  }

  /** The Flow module's syntax tree, parsed once. */
  private tree(flowPath: string): { ast: FlowNode } | { error: unknown } {
    let parsed = this.parsed.get(flowPath);
    if (parsed === undefined) {
      try {
        parsed = { ast: this.parse(this.read(flowPath) ?? "") };
      } catch (error) {
        parsed = { error };
      }
      this.parsed.set(flowPath, parsed);
    }
    return parsed;
  }

  /** `m.tsx` for a Flow module that holds JSX, `m.ts` otherwise. Asked for
   * each path the resolver and the lowering consider, so computed once. */
  presentedPath(path: string): string | null {
    let presented = this.presented.get(path);
    if (presented === undefined) {
      const parsed = this.isFlowFile(path) ? this.tree(path) : null;
      presented =
        parsed === null
          ? null
          : path.slice(0, -3) + ("ast" in parsed && containsJsx(parsed.ast) ? ".tsx" : ".ts");
      this.presented.set(path, presented);
    }
    return presented;
  }

  /** The Flow source a presented path (`.ts` or `.tsx`) stands for, or null. */
  flowPathOf(path: string): string | null {
    const base = path.endsWith(".ts")
      ? path.slice(0, -3)
      : path.endsWith(".tsx")
        ? path.slice(0, -4)
        : null;
    if (base === null) return null;
    const flowPath = base + ".js";
    return this.presentedPath(flowPath) === path ? flowPath : null;
  }

  /** The module presented at `path`, translated on first use. */
  module(path: string): FlowModule | null {
    const cached = this.modules.get(path);
    if (cached !== undefined) return cached;
    const flowPath = this.flowPathOf(path);
    if (flowPath === null) return null;
    const text = this.read(flowPath)!;
    let translation: EditedSource;
    try {
      const parsed = this.tree(flowPath);
      if ("error" in parsed) throw parsed.error;
      translation = translateFlow(text, parsed.ast, {
        types: this.types,
        constants: this.constants,
        jsx: path.endsWith(".tsx"),
      });
    } catch (error) {
      // A module that does not translate is reported at its Flow source
      // (flowTranslationFailures) and served as an empty module, so the
      // rest of the program still loads and the build stops at preflight.
      this.failures.push({ diagnostic: translationFailure(error, text, flowPath), text });
      translation = applySourceEdits("export {};\n", []);
    }
    const module = { flowPath, source: text, translation };
    this.modules.set(path, module);
    return module;
  }
}

/** Whether a syntax tree holds a JSX element or fragment. */
function containsJsx(n: FlowNode): boolean {
  if (n.type === "JSXElement" || n.type === "JSXFragment") return true;
  for (const [key, value] of Object.entries(n)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (
        child !== null &&
        typeof child === "object" &&
        typeof child.type === "string" &&
        containsJsx(child)
      )
        return true;
  }
  return false;
}

let active: FlowLayer | null = null;

/** Enables Flow for the program being loaded (null disables it). */
export function setFlowSources(
  options: FlowOptions | null,
  parse: FlowParser | undefined,
  read: (path: string) => string | null,
  exists: (path: string) => boolean,
): void {
  if (options === null) {
    active = null;
    return;
  }
  // A client that cannot load a Flow parser reports every Flow module.
  const parser =
    parse ??
    (() => {
      throw new FlowTranslateError("this scriptc client cannot parse Flow modules", 0);
    });
  active = new FlowLayer(parser, options, read, exists);
}

/** The TypeScript path a Flow source is presented at, or null. */
export function flowPresentedPath(path: string): string | null {
  return active === null ? null : active.presentedPath(path);
}

/** The translation served at a presented path, or undefined. */
export function flowPresentedSource(path: string): string | undefined {
  return active === null ? undefined : active.module(path)?.translation.text;
}

/** Whether the program hides `path`: a Flow source it presents as TypeScript. */
export function flowHidesFile(path: string): boolean {
  return active !== null && active.isFlowFile(path);
}

/** The Flow source a presented module stands for, or null. */
export function flowSourcePath(path: string): string | null {
  return active === null ? null : active.flowPathOf(path);
}

/** Whether `path` is a presented Flow module (a `.ts` or `.tsx` path that
 * exists only as a translation). TypeScript did not check it, so, like
 * JavaScript, a construct with no static lowering defers to a runtime fence
 * (lower-stmts.ts) instead of failing the build. */
export function isFlowModule(path: string): boolean {
  return active !== null && active.flowPathOf(path) !== null;
}

/** The Flow modules of the current load that did not translate: an
 * unsupported construct (SC1090), a syntax error (SC0001) or a translator
 * failure (SC9001), each located in
 * its Flow source, with the source texts the diagnostics render against. */
export function flowTranslationFailures(): {
  diagnostics: ScrDiagnostic[];
  texts: Map<string, string>;
} {
  const failures = active?.failures ?? [];
  return {
    diagnostics: failures.map((f) => f.diagnostic),
    texts: new Map(failures.map((f) => [f.diagnostic.loc.file, f.text])),
  };
}

/** The diagnostic for a module that did not translate: a form scriptc
 * does not support (SC1090), a syntax error (SC0001), or a translator
 * failure (SC9001, at the module's start). */
function translationFailure(error: unknown, text: string, flowPath: string): ScrDiagnostic {
  if (error instanceof FlowTranslateError) {
    const loc = { file: flowPath, start: error.pos, end: error.pos };
    return { ...unsupportedDiag("SC1090", loc), message: error.message };
  }
  // hermes-parser's syntax errors carry a 1-based line and a 0-based
  // column in UTF-8 bytes.
  const at = (error as { loc?: { line?: unknown; column?: unknown } } | null)?.loc;
  if (
    error instanceof SyntaxError &&
    typeof at?.line === "number" &&
    typeof at.column === "number"
  ) {
    let start = 0;
    for (let line = 1; line < at.line; line++) {
      const eol = text.indexOf("\n", start);
      if (eol < 0) break;
      start = eol + 1;
    }
    for (let bytes = 0; bytes < at.column && start < text.length && text[start] !== "\n";) {
      const code = text.codePointAt(start)!;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      start += code > 0xffff ? 2 : 1;
    }
    return {
      code: "SC0001",
      message: `Flow syntax error: ${error.message.split("\n")[0]!.replace(/ \(\d+:\d+\)$/, "")}`,
      loc: { file: flowPath, start, end: start },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "SC9001",
    message: `internal compiler error: translating this Flow module failed (${message}) — please report this`,
    loc: { file: flowPath, start: 0, end: 0 },
  };
}

/** The Flow source file and 1-based line of an offset in a presented
 * module, or null when `path` is not one: messages name the file the
 * program's author wrote. */
export function flowSourceLine(path: string, pos: number): { file: string; line: number } | null {
  const module = active === null ? null : active.module(path);
  if (module === null) return null;
  const original = module.translation.originalPosition(pos);
  let starts = lineStarts.get(module);
  if (starts === undefined) {
    starts = [0];
    for (let i = 0; i < module.source.length; i++)
      if (module.source.charCodeAt(i) === 10) starts.push(i + 1);
    lineStarts.set(module, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= original) low = mid;
    else high = mid - 1;
  }
  return { file: module.flowPath, line: low + 1 };
}

const lineStarts = new WeakMap<FlowModule, number[]>();

/** Where a runtime fence message says it is: the Flow source and line for
 * an offset in a presented Flow module, `file:line` (the given 1-based
 * line) otherwise. */
export function fenceLocation(file: string, pos: number, line: number): string {
  const flow = flowSourceLine(file, pos);
  return flow === null ? `${file}:${line}` : `${flow.file}:${flow.line}`;
}
