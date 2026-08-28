/* Library mode's export resolution input: what the ENTRY source file exports
 * as function declarations. Resolution runs on the frontend's program
 * object after preflight (design §5.3) — the export map may only name
 * exports of the profile's one entry module, and today's compilable export
 * surface for functions is exactly `export function f(...)` declarations
 * (export lists and re-exports are SC1014-fenced, so nothing else can
 * reach a compiled program). The per-declaration facts collected here are
 * what the SC4002/SC4004/SC4007 refusals key on; the marshalling check
 * (SC4003) runs later against the lowered IrFunction's types. */
import * as ts from "./ts7/adapter.js";
import type { SrcLoc } from "../ir/ir.js";

export interface EntryExportInfo {
  name: string;
  loc: SrcLoc;
  /** Declared type parameters — SC4007 (a profile entry needs one concrete
   * compiled signature). */
  generic: boolean;
  /** `async function` — SC4004. */
  async: boolean;
  /** `function*` — SC4004. */
  generator: boolean;
}

/** Every `export function f(...)` of the entry file, by exported name.
 * Overload signatures collapse onto one entry (same name, one body). */
export function entryFunctionExports(entry: ts.SourceFile): Map<string, EntryExportInfo> {
  const out = new Map<string, EntryExportInfo>();
  for (const stmt of entry.statements) {
    if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined) continue;
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    const name = stmt.name.text;
    if (out.has(name) && stmt.body === undefined) continue; // overload signature
    out.set(name, {
      name,
      loc: { file: entry.fileName, start: stmt.getStart(), end: stmt.end },
      generic: (stmt.typeParameters?.length ?? 0) > 0,
      async: mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true,
      generator: stmt.asteriskToken !== undefined,
    });
  }
  return out;
}
