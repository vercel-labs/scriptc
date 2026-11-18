// Namespace and default imports of a CommonJS module answer its exports
// object through Node's ESM-CJS interop: the namespace carries exactly the
// names Node's lexer detects, the default is module.exports itself, and a
// named import links only for a lexer-detected name. Reading any other
// member — or a lexer-detected name the module never assigned — is
// undefined, not a refusal.
import * as ns from './table.cjs';
import def from './table.cjs';
import { present, later } from './table.cjs';

console.log('namespace', ns.present, ns.absent, ns.absent === undefined, typeof ns.absent);
console.log('default', def.present, def.absent, typeof def.absent);
console.log('named', present, later, later === undefined, typeof later);
console.log('namespace later', ns.later, ns.later === undefined);
