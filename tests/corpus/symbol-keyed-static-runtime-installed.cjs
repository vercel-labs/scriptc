// A symbol-keyed static installed at RUN TIME (`Object.defineProperty` after
// the class declaration) is not in the declaration: the read consults the
// class value's own property table, which answers the installed value — and
// undefined for a key nobody installed, as Node does.
'use strict';

const installed = Symbol.for('runtime.installed');
const absent = Symbol.for('runtime.absent');

class Box {}
Object.defineProperty(Box, installed, { value: 'installed', enumerable: true, configurable: true });

console.log('symbol:', Box[installed], Box[absent]);

// A class that declares the key keeps its declared value; a subclass sees it.
class Holder {
  static [installed] = 'declared';
}
class HolderSub extends Holder {}
console.log('declared:', Holder[installed], HolderSub[installed]);
