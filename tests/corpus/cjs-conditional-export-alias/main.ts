// A default import (Node's module.exports) taken as a value: the alias is
// the chosen table's own exports object, so its identity, prototype and
// members answer as in Node. Writes through that object are visible to
// every read through the binding, while a named import keeps the snapshot
// Node gives it.
import lib from './lib.cjs';
import { mode as namedMode } from './lib.cjs';
import table from './table.cjs';

const alias = lib;
console.log(typeof alias, alias.mode, alias.hello());
console.log(Object.prototype.toString.call(alias));
console.log(Object.getPrototypeOf(alias) === Object.prototype);
console.log(Object.keys(alias).join(','));
console.log('hello' in alias, alias === lib);

export const reexported = alias;
console.log(typeof reexported, reexported.mode);

const second = lib;
console.log(alias === second);

const mutable = lib as any;
mutable.mode = 'mutated';
console.log(lib.mode, namedMode);
mutable.hello = () => 'replaced';
console.log(lib.hello());
delete mutable.hello;
console.log(typeof lib.hello);
Object.assign(mutable, { extra: 1 });
console.log((lib as any).extra);

const tableAlias = table as any;
tableAlias.count = 10;
console.log(table.count, table.bump(), table.count);
