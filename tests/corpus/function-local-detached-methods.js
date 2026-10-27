// A method of a function-local class that never reads `this` keeps working
// when it is taken off an instance and called detached or with another
// receiver.
'use strict';

function make(label) {
  class Box {
    one() {
      return 1;
    }

    named() {
      return `box ${label}`;
    }
  }
  return new Box();
}

const box = make('a');
const one = box.one;
console.log(one(), box.one.call(null), box.one.call({}), box.named());
console.log([box, make('b')].map((b) => b.one()).join(','));
