// A URLSearchParams record init evaluates its property initializers in
// source order, then appends the record's own keys in Reflect.ownKeys
// order (integer index keys ascending first), converting each value when
// its entry is appended. A later initializer cannot change a value an
// earlier one already read, and an integer key does not move its
// initializer ahead of the others.
'use strict';
const show = (fn) => {
  try {
    console.log('ret', JSON.stringify(fn()));
  } catch (e) {
    console.log(`${e.name}|${e.code}|${e.message}`);
  }
};
const seen = [];
const tag = (label, value) => {
  seen.push(label);
  return value;
};

const p = new URLSearchParams({ b: tag('b', '2'), 0: tag('0', '1'), a: tag('a', '3') });
console.log(p.toString());
console.log(seen.join(','));

// Integer keys order the record, whatever their source position.
const tail = new URLSearchParams({ b: 'B', 10: 'ten', 2: 'two', a: 'A', 0: 'zero' });
console.log(tail.toString());

// Conversion runs at append time, in the record's own key order.
const conversions = [];
const converting = (label) => ({
  toString() {
    conversions.push(label);
    return label;
  },
});
const q = new URLSearchParams({ b: converting('b'), 0: converting('0') });
console.log(q.toString());
console.log(conversions.join(','));

// Conversion follows every initializer, keys in enumeration order or not:
// `a`'s conversion runs after `b`'s initializer, not between the two reads.
const inOrder = [];
const convertNow = (label) => ({
  toString() {
    inOrder.push(`convert ${label}`);
    return label;
  },
});
const timed = new URLSearchParams({
  a: convertNow('a'),
  b: (inOrder.push('init b'), 'B'),
});
console.log(timed.toString());
console.log(inOrder.join(','));

// The value a property answers is the one read at its source position,
// even when a later initializer changes the variable it came from.
let v = 'before';
const r = new URLSearchParams({ b: v, 0: (v = 'after', 'zero') });
console.log(r.toString());
console.log(v);

// Only one initializer in the literal: source order and key order agree.
const one = new URLSearchParams({ b: tag('only b', 'B') });
console.log(one.toString());
console.log(seen.join(','));

// The same record shape through a variable.
const record = { b: tag('var b', 'B2'), 0: tag('var 0', '01') };
const fromVar = new URLSearchParams(record);
console.log(fromVar.toString());
console.log(seen.join(','));

// Present arguments evaluate before the missing-argument error, receiver
// first, and no conversion runs.
const calls = [];
const nameOf = () => {
  calls.push('name');
  return 'n';
};
const make = () => {
  calls.push('recv');
  return new URLSearchParams('a=1');
};
show(() => make().append(nameOf()));
console.log(calls.join(','));
show(() => make().set(nameOf()));
console.log(calls.join(','));
show(() => make().get());
console.log(calls.join(','));
show(() => make().delete(nameOf()));
console.log(calls.join(','));
show(() => make().getAll());
console.log(calls.join(','));
show(() => make().has(nameOf(), nameOf()));
console.log(calls.join(','));
