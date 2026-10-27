/* Flow sources (a project's `scriptc.flow` setting): JavaScript modules
 * with a `@flow` pragma compile as the TypeScript they translate to
 * (translate.ts).
 *
 * A Flow module `m.js` is presented as `m.ts`: the program serves the
 * translation at that path and hides the `.js` file, so the checker and
 * scriptc's resolver (resolve.ts normalizes every answer through
 * flowPresentedPath) treat it as TypeScript, and `./m` and `./m.js`
 * specifiers resolve to it as they do to any TypeScript source. Diagnostics
 * map the presented path and positions back to the Flow source
 * (flowSourceOf).
 *
 * Nothing here runs unless a load enables Flow: without the setting, no
 * file is read for a pragma and every hook answers immediately. */
import type { EditedSource } from "../source-edits.js";
import { FlowTranslateError, translateFlow, type FlowNode } from "./translate.js";

export { FlowTranslateError, type FlowNode } from "./translate.js";

/** A project's Flow settings (package.json `scriptc.flow`). */
export interface FlowOptions {
  /** Type names that compile as `unknown`: values the project keeps
   * checked-dynamic. */
  dynamicTypes?: readonly string[];
  /** Type names whose Flow type the project corrects, as the TypeScript
   * type they compile as (`{ "OptimisticKey": "symbol" }` for a symbol
   * Flow is told is `true`). */
  types?: Readonly<Record<string, string>>;
  /** Every project `.js` module is a Flow module, pragma or not (Flow's
   * own `all=true` option). */
  all?: boolean;
  /** The project's compile-time constants (`scriptc.constants`). */
  constants?: ReadonlyMap<string, boolean | number | string | null>;
}

/** Parses a Flow module (hermes-parser's ESTree, with ranges). */
export type FlowParser = (text: string, path: string) => FlowNode;

export interface FlowModule {
  /** The Flow source file. */
  flowPath: string;
  /** The TypeScript path the program serves it at. */
  presentedPath: string;
  translation: EditedSource;
}

/** The leading comments hold `@flow` or `@noflow`: either way the module
 * is written in Flow's syntax (`@noflow` only opts out of checking). */
export function hasFlowPragma(text: string): boolean {
  const head =
    /^(?:\s|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/|#![^\n]*\n)*/.exec(text.slice(0, 8192))?.[0] ?? "";
  return /@(?:no)?flow\b/.test(head);
}

class FlowLayer {
  private readonly pragma = new Map<string, boolean>();
  private readonly modules = new Map<string, FlowModule>();
  private readonly types: ReadonlyMap<string, string>;
  private readonly constants: ReadonlyMap<string, boolean | number | string | null>;
  private readonly all: boolean;

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
      flow =
        text !== null &&
        (this.all || hasFlowPragma(text)) &&
        !this.exists(path.slice(0, -3) + ".ts");
      this.pragma.set(path, flow);
    }
    return flow;
  }

  presentedPath(path: string): string | null {
    return this.isFlowFile(path) ? path.slice(0, -3) + ".ts" : null;
  }

  /** The module presented at `path` (a `.ts` path), translated on first use. */
  module(path: string): FlowModule | null {
    if (!path.endsWith(".ts")) return null;
    const cached = this.modules.get(path);
    if (cached !== undefined) return cached;
    const flowPath = path.slice(0, -3) + ".js";
    if (!this.isFlowFile(flowPath)) return null;
    const text = this.read(flowPath)!;
    let translation: EditedSource;
    try {
      translation = translateFlow(text, this.parse(text, flowPath), {
        types: this.types,
        constants: this.constants,
      });
    } catch (error) {
      if (error instanceof FlowTranslateError) {
        const line = text.slice(0, error.pos).split("\n").length;
        throw new Error(`${flowPath}:${line}: ${error.message}`);
      }
      throw error;
    }
    const module = { flowPath, presentedPath: path, translation };
    this.modules.set(path, module);
    return module;
  }

  /** Every module translated so far. */
  translated(): readonly FlowModule[] {
    return [...this.modules.values()];
  }
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
  if (parse === undefined) throw new Error("this scriptc client cannot parse Flow sources");
  active = new FlowLayer(parse, options, read, exists);
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

/** Whether `path` exists only as a presented Flow module. */
export function flowPresentsFile(path: string): boolean {
  return active !== null && path.endsWith(".ts") && active.isFlowFile(path.slice(0, -3) + ".js");
}

/** Whether `path` is a presented Flow module: TypeScript did not check it,
 * so, like JavaScript, a construct with no static lowering defers to a
 * runtime fence (lower-stmts.ts) instead of failing the build. */
export function isFlowModule(path: string): boolean {
  return active !== null && path.endsWith(".ts") && active.isFlowFile(path.slice(0, -3) + ".js");
}

/** The Flow module presented at `path`, for diagnostics. */
export function flowSourceOf(path: string): FlowModule | null {
  return active === null ? null : active.module(path);
}
