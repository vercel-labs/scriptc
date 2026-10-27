// `#x in v` where v is a checked value: objects answer by brand, and a
// primitive operand throws Node's TypeError, which names the value as
// String(v) spells it.
'use strict';

class Base {}

class Box extends Base {
  #value = 1;

  static is(v) {
    return #value in v;
  }
}

class Sub extends Box {}

console.log(Box.is(new Box()), Box.is(new Sub()), Box.is(new Base()));
console.log(Box.is({}), Box.is([]), Box.is(function () {}), Box.is(Box));

const primitives = [1, -0, NaN, 1.5, 'str', '', true, false, undefined, null, 10n, -5n, Symbol('s'), Symbol()];
for (const v of primitives) {
  try {
    console.log('no throw', Box.is(v));
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
}
