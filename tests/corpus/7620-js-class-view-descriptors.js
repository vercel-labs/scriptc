// An instance of a JS class with public fields keeps its own properties in
// a property bag, and untyped code that calls a method on it sees a view
// built from that bag: data properties with their attributes, accessors,
// index-like keys (which come first, in ascending order), symbols, and
// properties added or removed after construction. Every refresh of the view
// must copy the bag exactly.
'use strict';

class Box {
  label = 'box';
  count = 0;
  constructor(n) {
    this.count = n;
  }
  describe() {
    return `${this.label}:${this.count}`;
  }
  bump() {
    this.count++;
    return this;
  }
}

function call(target, method, ...args) {
  return target[method](...args);
}

function put(target, key, value) {
  target[key] = value;
}

function drop(target, key) {
  delete target[key];
}

function show(title, target) {
  const lines = [];
  for (const key of Reflect.ownKeys(target)) {
    const d = Object.getOwnPropertyDescriptor(target, key);
    const kind = 'value' in d ? `value=${String(d.value)} writable=${d.writable}` : `get=${typeof d.get} set=${typeof d.set}`;
    lines.push(`  ${String(key)}: ${kind} enumerable=${d.enumerable} configurable=${d.configurable}`);
  }
  console.log(`${title}\n${lines.join('\n')}`);
}

const box = new Box(2);
Object.defineProperty(box, 'hidden', { value: 42, enumerable: false, writable: false, configurable: true });
Object.defineProperty(box, 'computed', {
  get() {
    return this.count * 10;
  },
  set(v) {
    this.count = v / 10;
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(box, 'getterOnly', { get: () => 'g', enumerable: false, configurable: false });
put(box, 2, 'two');
put(box, 1, 'one');
put(box, 'extra', 'x');
const tag = Symbol('tag');
put(box, tag, 'symbol');

console.log(call(box, 'describe'));
show('after construction', box);
console.log('keys', Object.keys(box).join(','));

call(box, 'bump');
put(box, 'computed', 70);
drop(box, 'extra');
put(box, 'later', true);
console.log(call(box, 'describe'));
show('after changes', box);
console.log('computed', box.computed, 'hidden', box.hidden, 'getterOnly', box.getterOnly);

// Many views in a row see the same, current properties.
let total = 0;
for (let i = 0; i < 5; i++) {
  call(box, 'bump');
  total += Object.keys(box).length;
}
console.log('total keys', total, call(box, 'describe'));

const other = new Box(7);
console.log(call(other, 'describe'), Object.keys(other).join(','));
try {
  call(box, 'missing');
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
