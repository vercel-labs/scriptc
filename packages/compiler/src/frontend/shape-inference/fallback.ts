/* Shape inference never breaks compilation: when the lowering refuses code
 * with the overlay on, the overlay annotations the refusal depends on are
 * dropped and the program is loaded and lowered again, so those
 * declarations compile untyped (as they do without the overlay).
 *
 * Attribution reads the refused program. A refusal depends on:
 * - the annotations of the declarations enclosing it (an annotated
 *   function's parameter types, a typed local, a receiver cast);
 * - the annotations of the declarations its expression names (a method
 *   whose annotated return type the refused member access reads, a field
 *   whose annotated type the access sees), followed through the return
 *   expressions of unannotated functions, whose result types the checker
 *   infers from what they return.
 *
 * pipeline.ts escalates when a round does not converge: first the
 * overlay of every file involved, then the whole overlay for the build. */
import * as ts from "../ts7/adapter.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { OVERLAY_MARK, overlayAnnotationIds } from "./overlay.js";

export interface OverlayAttribution {
  /** Annotation ids per overlay file. */
  readonly annotations: Map<string, Set<number>>;
  /** Overlay files a refusal involves (where it sits, or what it names). */
  readonly files: Set<string>;
  /** Refusals with no overlay annotation or file to blame. */
  readonly unattributed: number;
}

/** How far the attribution follows unannotated functions' return
 * expressions. */
const RETURN_DEPTH = 3;

export function attributeOverlayRefusals(
  program: ts.Program,
  diagnostics: readonly ScrDiagnostic[],
  overlayFiles: ReadonlySet<string>,
  /** Failing refusals may blame every annotation in their enclosing
   * function as a last resort; refusals deferred to run time do not (most
   * exist without the overlay too). */
  wholeFunctions = true,
): OverlayAttribution {
  const annotations = new Map<string, Set<number>>();
  const files = new Set<string>();
  let unattributed = 0;
  let checker: ts.TypeChecker | null = null;
  // Blamed annotations and files so far (a refusal that adds none is
  // unattributed).
  let blamed = 0;
  const addFile = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    blamed++;
  };
  const add = (file: string, id: number): void => {
    let set = annotations.get(file);
    if (set === undefined) annotations.set(file, (set = new Set()));
    if (!set.has(id)) blamed++;
    set.add(id);
    addFile(file);
  };
  // The ids in the trivia before a node (where the overlay writes them).
  const marksOf = (node: ts.Node): number[] => {
    const sf = node.getSourceFile();
    if (!overlayFiles.has(sf.fileName)) return [];
    const trivia = sf.text.slice(node.pos, ts.tokenStartOfNode(node));
    return trivia.includes(OVERLAY_MARK) ? overlayAnnotationIds(trivia) : [];
  };
  const blameNode = (node: ts.Node): boolean => {
    const ids = marksOf(node);
    for (const id of ids) add(node.getSourceFile().fileName, id);
    return ids.length > 0;
  };
  // A declaration's annotation: on the declaration, or on the statement
  // holding it (`/** @type */ const x = …`, `/** @type */ this.f = …`).
  const visitedDecls = new Set<ts.Node>();
  const blameDeclaration = (decl: ts.Node, depth: number): void => {
    if (visitedDecls.has(decl)) return;
    visitedDecls.add(decl);
    const sf = decl.getSourceFile();
    if (!overlayFiles.has(sf.fileName)) return;
    addFile(sf.fileName);
    let marked = false;
    for (let n: ts.Node | undefined = decl, i = 0; n !== undefined && i < 4; n = n.parent, i++) {
      if (blameNode(n)) marked = true;
      if (ts.isStatement(n) || isClassMember(n) || ts.isSourceFile(n)) break;
    }
    // An unannotated function's result type comes from its returns.
    if (!marked && depth < RETURN_DEPTH && ts.isFunctionLike(decl)) {
      const body = (decl as { body?: ts.Node }).body;
      if (body !== undefined) {
        if (!ts.isBlock(body)) blameReferences(body, depth + 1);
        else
          visitReturns(body, (e) => {
            blameReferences(e, depth + 1);
          });
      }
    }
  };
  // Every declaration an expression's names resolve to.
  const blameReferences = (root: ts.Node, depth: number): void => {
    checker ??= program.getTypeChecker();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        let symbol: ts.Symbol | undefined;
        try {
          symbol = checker!.getSymbolAtLocation(n);
        } catch {
          symbol = undefined;
        }
        for (const d of symbol?.declarations ?? []) blameDeclaration(d, depth);
      }
      ts.forEachChild(n, (c) => {
        visit(c);
        return undefined;
      });
    };
    visit(root);
  };

  // Calls of each function declared in an overlay file, by declaration.
  let calls: Map<ts.Node, ts.CallExpression[]> | null = null;
  const callsOf = (fn: ts.Node): readonly ts.CallExpression[] => {
    if (calls === null) {
      calls = new Map();
      checker ??= program.getTypeChecker();
      for (const file of overlayFiles) {
        const sf = program.getSourceFile(file);
        if (sf === undefined) continue;
        const visit = (n: ts.Node): void => {
          const callee = !ts.isCallExpression(n)
            ? undefined
            : ts.isIdentifier(n.expression)
              ? n.expression
              : ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.name)
                ? n.expression.name
                : undefined;
          if (callee !== undefined && ts.isCallExpression(n)) {
            let decl: ts.Node | undefined;
            try {
              decl = checker!.getSymbolAtLocation(callee)?.declarations[0];
            } catch {
              decl = undefined;
            }
            if (decl !== undefined) {
              let list = calls!.get(decl);
              if (list === undefined) calls!.set(decl, (list = []));
              list.push(n);
            }
          }
          ts.forEachChild(n, (c) => {
            visit(c);
            return undefined;
          });
        };
        visit(sf);
      }
    }
    return calls.get(fn) ?? [];
  };

  // Annotations whose type text names an identifier, by identifier: a
  // class the lowering refuses compiles dynamically until a type names it.
  let naming: Map<string, [string, number][]> | null = null;
  const blameNaming = (name: string): void => {
    if (naming === null) {
      naming = new Map();
      for (const file of overlayFiles) {
        const text = program.getSourceFile(file)?.text;
        if (text === undefined) continue;
        for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
          if (!m[0].includes(OVERLAY_MARK)) continue;
          const ids = overlayAnnotationIds(m[0]);
          for (const w of new Set(m[0].match(/[A-Za-z_$][\w$]*/g) ?? [])) {
            let l = naming.get(w);
            if (l === undefined) naming.set(w, (l = []));
            for (const id of ids) l.push([file, id]);
          }
        }
      }
    }
    for (const [file, id] of naming.get(name) ?? []) add(file, id);
  };
  // The class a refusal is about: a field or the heritage of a class
  // declaration, or a `new C(...)` of a named class.
  const refusedClassName = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) return n.expression.text;
      if (ts.isFunctionLike(n)) return null;
      if (ts.isClassLikeDeclaration(n)) {
        const name = (n as { name?: ts.Node }).name;
        return name !== undefined && ts.isIdentifier(name) ? name.text : null;
      }
    }
    return null;
  };

  for (const d of diagnostics) {
    const sf = program.getSourceFile(d.loc.file);
    if (sf === undefined) {
      unattributed++;
      continue;
    }
    const before = blamed;
    if (overlayFiles.has(sf.fileName)) addFile(sf.fileName);
    const node = innermostNodeAt(sf, d.loc.start, Math.max(d.loc.end, d.loc.start));
    // Enclosing annotated declarations, then the names of the refused
    // expression, or failing that of the statement around it.
    let statement: ts.Node = node;
    for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
      blameNode(n);
      if (statement === node && (ts.isStatement(n) || isClassMember(n))) statement = n;
    }
    const refusedClass = refusedClassName(node);
    if (refusedClass !== null) blameNaming(refusedClass);
    const own = blamed;
    blameReferences(node, 0);
    if (blamed === own && statement !== node) blameReferences(statement, 0);
    // A function without parameter annotations is instantiated per call
    // site from its arguments' types: blame what the arguments name.
    if (blamed === own) {
      const fn = enclosingFunction(node);
      if (fn !== undefined)
        for (const call of callsOf(fn))
          for (const arg of call.arguments.nodes) blameReferences(arg, 1);
    }
    // Still nothing: the lowering of the enclosing function changed as a
    // whole (an instantiation the annotations inside it made possible).
    if (blamed === before && wholeFunctions) {
      const fn = enclosingFunctionLike(node);
      if (fn !== undefined && overlayFiles.has(fn.getSourceFile().fileName)) {
        const visit = (n: ts.Node): void => {
          blameNode(n);
          ts.forEachChild(n, (c) => {
            visit(c);
            return undefined;
          });
        };
        visit(fn);
      }
    }
    if (blamed === before) unattributed++;
  }
  return { annotations, files, unattributed };
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent)
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n;
    else if (ts.isFunctionLike(n)) return undefined;
  return undefined;
}

function enclosingFunctionLike(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent)
    if (ts.isFunctionLike(n)) return n;
  return undefined;
}

function visitReturns(body: ts.Node, f: (e: ts.Expression) => void): void {
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLikeDeclaration(n)) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined) f(n.expression);
    ts.forEachChild(n, (c) => {
      visit(c);
      return undefined;
    });
  };
  ts.forEachChild(body, (c) => {
    visit(c);
    return undefined;
  });
}

/** The innermost node whose token span covers [start, end). */
export function innermostNodeAt(sf: ts.SourceFile, start: number, end: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (c) => {
      if (next === undefined && ts.tokenStartOfNode(c) <= start && c.end >= end) next = c;
      return undefined;
    });
    if (next === undefined) return node;
    node = next;
  }
}

function isClassMember(n: ts.Node): boolean {
  return n.parent !== undefined && ts.isClassLikeDeclaration(n.parent) && n !== n.parent.name;
}
