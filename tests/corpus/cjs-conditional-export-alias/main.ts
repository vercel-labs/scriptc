// A default import (Node's module.exports) taken as a value: the alias is
// the chosen table's own exports object, so its identity, prototype and
// members answer as in Node.
import lib from './lib.cjs';

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
