/* Library mode's export resolution input: what the ENTRY module exports,
 * resolved through its export table. Resolution runs on the frontend's
 * program object after preflight (design §5.3) — the export map may only
 * name exports of the profile's one entry module, and the compilable
 * export surface for functions is a function DECLARATION reached from
 * that module's exports. A direct `export function f(...)`, an export
 * list (`export { f }`, `export { f as g }`), and a re-export
 * (`export { f } from "./m"`, `export * from "./m"`) all name the same
 * declaration, so the facts (and, in the lowering, the unit the
 * declaration compiles to) come from the declaration site: the one-line
 * facade SC4002 points authors to is exactly as good as declaring the
 * function in the entry. The per-declaration facts collected here are
 * what the SC4002/SC4004/SC4007 refusals key on; the marshalling check
 * (SC4003) runs later against the lowered IrFunction's types. */
import * as ts from "./ts7/adapter.js";
import type { SrcLoc } from "../ir/ir.js";

/** An export name that resolves to a function declaration. */
export interface EntryFunctionExport {
  kind: "function";
  name: string;
  /** The declaration site (where SC4003/SC4004/SC4007 anchor). */
  loc: SrcLoc;
  /** Declared type parameters — SC4007 (a profile entry needs one concrete
   * compiled signature). */
  generic: boolean;
  /** `async function` — SC4004. */
  async: boolean;
  /** `function*` — SC4004. */
  generator: boolean;
}

/** An export name that resolves to something other than a function
 * declaration: SC4002 names what the name denotes. */
export interface EntryValueExport {
  kind: "value";
  name: string;
  loc: SrcLoc;
  /** "a class", "a variable", "a type", … */
  what: string;
}

export type EntryExport = EntryFunctionExport | EntryValueExport;

/** The symbol the entry module's export `name` denotes, with aliases (a
 * local export list, a named re-export, and the chains they can form)
 * resolved to the declaration that supplies the value. Null when the
 * entry module exports nothing under that name. */
export function resolveEntryExportSymbol(
  checker: ts.TypeChecker,
  entry: ts.SourceFile,
  name: string,
): ts.Symbol | null {
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (moduleSymbol === undefined) return null;
  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => ts.symbolName(s) === name);
  if (exported === undefined) return null;
  let symbol = exported;
  // Alias chains are bounded like any other syntactic walk: a malformed or
  // cyclic export graph must not spin here (the checker itself refuses
  // cycles earlier; this is the belt).
  for (let hops = 0; hops < 32 && (symbol.flags & ts.SymbolFlags.Alias) !== 0; hops++)
    symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Resolve the profile's export names against the entry module — the facts
 * the SC4002/SC4004/SC4007 refusals key on, by exported name. Names the
 * entry does not export at all are absent from the map. */
export function entryExportFacts(
  program: ts.Program,
  entry: ts.SourceFile,
  names: readonly string[],
): Map<string, EntryExport> {
  const out = new Map<string, EntryExport>();
  if (names.length === 0) return out;
  const checker = program.getTypeChecker();
  for (const name of names) {
    const symbol = resolveEntryExportSymbol(checker, entry, name);
    if (symbol === null) continue; // not exported: SC4002
    out.set(name, exportFactOf(symbol, name));
  }
  return out;
}

/** One export symbol's fact. Overload signatures collapse onto their
 * implementation (same symbol, one body); a name that denotes any other
 * value or type is described by what it is so SC4002 can say so. */
function exportFactOf(symbol: ts.Symbol, name: string): EntryExport {
  const declarations = symbol.declarations;
  const functions = declarations.filter((d): d is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(d),
  );
  if (functions.length > 0) {
    const impl = functions.find((d) => d.body !== undefined) ?? functions[functions.length - 1]!;
    const sf = ts.getSourceFileOfNode(impl);
    const mods = ts.canHaveModifiers(impl) ? ts.getModifiers(impl) : undefined;
    return {
      kind: "function",
      name,
      loc: { file: sf.fileName, start: ts.tokenStartOfNode(impl), end: impl.end },
      generic: (impl.typeParameters?.nodes.length ?? 0) > 0,
      async: mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true,
      generator: impl.asteriskToken !== undefined,
    };
  }
  const declaration = symbol.valueDeclaration ?? declarations[0];
  const loc =
    declaration === undefined
      ? { file: "", start: 0, end: 0 }
      : {
          file: ts.getSourceFileOfNode(declaration).fileName,
          start: ts.tokenStartOfNode(declaration),
          end: declaration.end,
        };
  return { kind: "value", name, loc, what: whatItIs(symbol, declaration) };
}

/** A short noun phrase for what a non-function export denotes, for the
 * SC4002 message. */
function whatItIs(symbol: ts.Symbol, declaration: ts.Node | undefined): string {
  if (declaration !== undefined) {
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return "a class";
    if (ts.isEnumDeclaration(declaration)) return "an enum";
    if (ts.isVariableDeclaration(declaration)) return "a variable";
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration))
      return "an imported binding";
    if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))
      return "a type";
    if (ts.isModuleDeclaration(declaration)) return "a namespace";
  }
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return "a class";
  if ((symbol.flags & ts.SymbolFlags.Enum) !== 0) return "an enum";
  if ((symbol.flags & ts.SymbolFlags.Variable) !== 0) return "a variable";
  if ((symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) !== 0) return "a type";
  return "a non-function value";
}
