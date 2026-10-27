/* Provenance of the @scriptc/experimental exports. The package is scriptc's
 * own (packages/experimental): Node.js runs its JavaScript implementation,
 * scriptc builds lower its exports (lowering/lifetime-regions.ts,
 * lowering/intern-tables.ts, lowering/thread-slots.ts) and never compile
 * its body. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ts from "./ts7/adapter.js";

export const EXPERIMENTAL_MODULE = "@scriptc/experimental";

export type ExperimentalMember = "LifetimeRegion" | "InternTable" | "ThreadSlots";

/** The @scriptc/experimental export an identifier is a named-import binding of. */
export function experimentalImportOf(
  program: ts.Program,
  ident: ts.Identifier,
): ExperimentalMember | null {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isImportSpecifier(decl)) return null;
  const importDecl = decl.parent?.parent?.parent;
  if (
    !ts.isImportDeclaration(importDecl) ||
    !ts.isStringLiteral(importDecl.moduleSpecifier) ||
    importDecl.moduleSpecifier.text !== EXPERIMENTAL_MODULE
  )
    return null;
  const member = decl.propertyName?.text ?? decl.name.text;
  return member === "LifetimeRegion" || member === "InternTable" || member === "ThreadSlots"
    ? member
    : null;
}

/** Whether `sf` is the package's own declaration file: its directory's
 * package.json names @scriptc/experimental. `known` caches the answer per
 * directory (the caller owns it for one compile). */
export function isExperimentalDeclarationFile(
  sf: ts.SourceFile,
  known: Map<string, boolean>,
): boolean {
  if (!sf.isDeclarationFile) return false;
  const dir = dirname(sf.fileName);
  let answer = known.get(dir);
  if (answer === undefined) {
    const manifest = join(dir, "package.json");
    try {
      answer =
        existsSync(manifest) &&
        (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name ===
          EXPERIMENTAL_MODULE;
    } catch {
      answer = false;
    }
    known.set(dir, answer);
  }
  return answer;
}

/** The LifetimeRegion member a property access names (`region.run`), by
 * the declaration it resolves to. */
export function lifetimeRegionMemberOf(
  program: ts.Program,
  access: ts.PropertyAccessExpression,
  known: Map<string, boolean>,
): "run" | "release" | null {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(access.name);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isMethodDeclaration(decl)) return null;
  const owner = decl.parent;
  if (
    !ts.isClassDeclaration(owner) ||
    owner.name?.text !== "LifetimeRegion" ||
    !isExperimentalDeclarationFile(ts.getSourceFileOfNode(owner), known)
  )
    return null;
  const name = access.name.text;
  return name === "run" || name === "release" ? name : null;
}

export type InternTableMember = "get" | "has" | "getOrInsert" | "getOrInsertComputed" | "size";

/** The InternTable member a property access names (`table.get`), by the
 * declaration it resolves to. */
export function internTableMemberOf(
  program: ts.Program,
  access: ts.PropertyAccessExpression,
  known: Map<string, boolean>,
): InternTableMember | null {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(access.name);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (
    decl === undefined ||
    !(
      ts.isMethodDeclaration(decl) ||
      ts.isPropertyDeclaration(decl) ||
      ts.isGetAccessorDeclaration(decl)
    )
  )
    return null;
  const owner = decl.parent;
  if (
    !ts.isClassDeclaration(owner) ||
    owner.name?.text !== "InternTable" ||
    !isExperimentalDeclarationFile(ts.getSourceFileOfNode(owner), known)
  )
    return null;
  const name = access.name.text;
  return name === "get" ||
    name === "has" ||
    name === "getOrInsert" ||
    name === "getOrInsertComputed" ||
    name === "size"
    ? name
    : null;
}

export type ThreadSlotsMember = "get" | "has" | "set" | "delete";

/** The ThreadSlots member a property access names (`slots.get`), by the
 * declaration it resolves to. */
export function threadSlotsMemberOf(
  program: ts.Program,
  access: ts.PropertyAccessExpression,
  known: Map<string, boolean>,
): ThreadSlotsMember | null {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(access.name);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isMethodDeclaration(decl)) return null;
  const owner = decl.parent;
  if (
    !ts.isClassDeclaration(owner) ||
    owner.name?.text !== "ThreadSlots" ||
    !isExperimentalDeclarationFile(ts.getSourceFileOfNode(owner), known)
  )
    return null;
  const name = access.name.text;
  return name === "get" || name === "has" || name === "set" || name === "delete" ? name : null;
}
