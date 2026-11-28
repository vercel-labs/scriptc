// STATIC symbol-keyed members are keyed by the SYMBOL, not by its
// description: two `Symbol('same')` calls are two keys even though inspect
// prints them alike, and a subclass's key never reads a base's slot. A class
// that keeps its statics in the constructor's property table (a static
// accessor makes it do that) keys them by the symbol as well, so reads,
// inherited reads and calls answer the same values.
'use strict';

const { inspect } = require('util');

const first = Symbol('same');
const second = Symbol('same');
const shared = Symbol.for('shared');

class Base {
  static [first] = 'base-first';
  static [shared] = 'base-shared';
  static method() {
    return 'base-method';
  }
}
class Adds extends Base {
  static [second] = 'adds-second';
}
class Shadows extends Base {
  static [first] = 'shadows-first';
}
class Inherits extends Base {}

console.log('base:', Base[first], Base[second], Base[shared]);
console.log('adds:', Adds[first], Adds[second], Adds[shared]);
console.log('shadows:', Shadows[first], Shadows[second]);
console.log('inherits:', Inherits[first], Inherits[second], Inherits[shared]);

class Table {
  static get sized() {
    return 1;
  }
  static [first] = 'table-first';
  static [second]() {
    return 'table-second';
  }
}
class TableSub extends Table {
  static [first] = 'table-shadow';
}
class TableInherits extends Table {}

console.log('table:', Table[first], Table[second](), Table.sized);
console.log('table sub:', TableSub[first], TableSub[second](), TableInherits[first]);

// A runtime-backed subclass that OVERRIDES an inherited native symbol static
// reads its own value, and one that does not override reads the base's.
class NativeBase {
  static [first] = 'native-base';
}
class TableOverride extends NativeBase {
  static get sized() {
    return 2;
  }
  static [first] = 'table-override';
}
class TableKeeps extends NativeBase {
  static get sized() {
    return 3;
  }
}
console.log('override:', NativeBase[first], TableOverride[first], TableKeeps[first]);

// A class value held by an untyped parameter dispatches on the runtime class:
// a subclass's own getter answers the read.
const gate = Symbol.for('same-gate');
class Gate {
  static get [gate]() {
    return true;
  }
}
class Deny extends Gate {
  static get [gate]() {
    return false;
  }
}
function check(C) {
  return C[gate];
}
console.log('dispatch:', check(Gate), check(Deny));

// Instance slots key by identity too: two equal descriptions are two fields.
class Holder {
  constructor() {
    this[first] = 1;
    this[second] = 2;
  }
}
const holder = new Holder();
console.log('holder:', holder[first], holder[second]);
console.log(inspect(holder));
