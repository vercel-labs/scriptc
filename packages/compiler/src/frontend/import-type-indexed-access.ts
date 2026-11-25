/* A type-position `import('spec')['name']` names the type of that module
 * member's value, exactly as `typeof import('spec')['name']` does.
 *
 * The checker reads the import type as a TYPE reference to the module, so it
 * refuses the indexed access outright (TS1340, "Module './n.js' does not refer
 * to a type, but is used as a type here. Did you mean 'typeof import('./n.js')'?")
 * and types the whole access as `any`. Published JavaScript writes the form
 * anyway, where the type position is documentation rather than a checked
 * declaration (svelte 4's `@param {import('./utils.js')['not_equal']}`
 * type-checks only because its tsconfig leaves checkJs off, and tsc's own hint
 * names the form the author meant).
 *
 * scriptc compiles the module the specifier names, so the member's value type
 * is available and is what the site asks for. The file carrying such a site is
 * served every world, the tsc gate included, with `typeof ` before the import
 * type, the form the checker resolves; nothing else about the file changes, and
 * a program without a site is served its files untouched. */

import * as ts from "./ts7/adapter.js";

/** Whether `node` is a type-position import type that an indexed access
 * immediately follows: `import('spec')['name']`, before a `typeof` is added.
 * A qualified form (`import('spec').Name['name']`) indexes the named member,
 * not the module, and is left alone. */
export function isIndexedImportType(node: ts.Node | undefined): node is ts.ImportTypeNode {
  if (node === undefined || !ts.isImportTypeNode(node) || node.isTypeOf) return false;
  if (node.qualifier !== undefined) return false;
  const parent = node.parent;
  return parent !== undefined && ts.isIndexedAccessTypeNode(parent) && parent.objectType === node;
}

/** The offset of every such site's `import` token in `sf`, in source order. */
function siteStarts(sf: ts.SourceFile): number[] {
  const starts: number[] = [];
  const visit = (node: ts.Node): void => {
    if (isIndexedImportType(node)) starts.push(ts.tokenStartOfNode(node));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return starts;
}

/** The files of the lowering world that carry an indexed import type, each
 * with the text it is served: every site's `import` token preceded by
 * `typeof `. A file without a site is absent (and is served untouched). */
export function importTypeIndexedAccessSources(program: ts.Program): Map<string, string> {
  const sources = new Map<string, string>();
  for (const sf of program.getImplementationSourceFiles()) {
    // The prefilter: the site spells `import(` in the file's text, JSDoc
    // comments included. Reading the syntax tree of every file would decode
    // the whole program for a form hardly any program writes. Asking through
    // the observer records the question's answer, not a read of the whole
    // text, so a comment edit of a file without the form stays cacheable.
    if (!ts.sourceTextIncludes(sf, "import(")) continue;
    const starts = siteStarts(sf);
    if (starts.length === 0) continue;
    let text = sf.text;
    for (let index = starts.length - 1; index >= 0; index--) {
      const at = starts[index]!;
      text = text.slice(0, at) + "typeof " + text.slice(at);
    }
    sources.set(sf.fileName, text);
  }
  return sources;
}
