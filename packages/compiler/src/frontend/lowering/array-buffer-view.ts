/* The lib's `ArrayBufferView` interface as a value type. It is the common
 * supertype of every typed array and DataView, so a value the program types
 * `ArrayBufferView` stays the checked-dynamic value (type-mapper.ts) and its
 * `buffer`, `byteOffset` and `byteLength` reads stay dynamic, answering from
 * the native view the value holds (narrowing.ts). Both mappings are gated on
 * the program naming the type: the same name is an arm of the builtin
 * declarations' `BinaryLike`, where mapping it would reshape ambient
 * signature types a program never wrote, and the standard library keeps its
 * existing paths. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Whether a compiled source names `ArrayBufferView` — a type annotation, a
 * cast, any identifier spelling of the name. A declaration file does not
 * count: the standard library's and a package's own declarations keep their
 * existing mappings. Comments and string literals are not identifiers, so
 * mentioning the name in prose does not turn the mapping on. */
export function programNamesArrayBufferView(lowerer: Lowerer): boolean {
  for (const sf of lowerer.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!ts.sourceTextIncludes(sf, "ArrayBufferView")) continue;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === "ArrayBufferView") {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) return true;
  }
  return false;
}
