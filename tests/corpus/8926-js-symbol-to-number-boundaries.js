// Symbol arguments at the DataView and typed-array boundaries. ToNumber
// and ToIndex throw Node's "Cannot convert a Symbol value to a number" for
// a Symbol input, and the throw happens after every argument has been
// evaluated. A JavaScript source used to refuse these calls statically, and
// the deferred fence threw a plain Error instead of the TypeError.
'use strict';

function report(label, fn) {
  try {
    console.log(label + ': ok ' + String(fn()));
  } catch (e) {
    console.log(label + ': ' + e.name + ': ' + e.message);
    console.log(label + ': is TypeError ' + (e instanceof TypeError) + ' ' + (e.constructor === TypeError));
  }
}

const buffer = new ArrayBuffer(16);
const view = new DataView(buffer);

// Every numeric DataView getter takes its byteOffset through ToIndex.
report('getInt8 symbol offset', () => view.getInt8(Symbol('1')));
report('getUint8 symbol offset', () => view.getUint8(Symbol('1')));
report('getInt16 symbol offset', () => view.getInt16(Symbol('1')));
report('getUint16 symbol offset', () => view.getUint16(Symbol('1'), true));
report('getInt32 symbol offset', () => view.getInt32(Symbol('1')));
report('getUint32 symbol offset', () => view.getUint32(Symbol('1'), true));
report('getFloat32 symbol offset', () => view.getFloat32(Symbol('1')));
report('getFloat64 symbol offset', () => view.getFloat64(Symbol('1')));

// The setters convert the offset and the value the same way.
report('setInt8 symbol offset', () => view.setInt8(Symbol('1'), 1));
report('setUint8 symbol offset', () => view.setUint8(Symbol('1'), 1));
report('setInt16 symbol offset', () => view.setInt16(Symbol('1'), 1));
report('setUint16 symbol offset', () => view.setUint16(Symbol('1'), 1, true));
report('setInt32 symbol offset', () => view.setInt32(Symbol('1'), 1));
report('setUint32 symbol offset', () => view.setUint32(Symbol('1'), 1, true));
report('setFloat32 symbol offset', () => view.setFloat32(Symbol('1'), 1));
report('setFloat64 symbol offset', () => view.setFloat64(Symbol('1'), 1));

// A missing value is ToNumber(undefined), so the offset still converts
// first (and throws for a Symbol) and a present offset writes NaN.
report('setFloat32 symbol offset, no value', () => view.setFloat32(Symbol('1')));
report('setInt8 missing value', () => view.setInt8(3));
console.log('missing value byte: ' + view.getInt8(3));

// A Symbol byteOffset at the typed-array constructors is ToIndex too.
report('Uint8Array buffer symbol offset', () => new Uint8Array(buffer, Symbol('1')));
report('Uint8Array length symbol', () => new Uint8Array(Symbol('1')));
report('Int32Array buffer symbol offset', () => new Int32Array(buffer, Symbol('1')));

// A Symbol byteOffset still converts no later argument: the throw is the
// first conversion, so the littleEndian argument never runs its effect.
const order = [];
report('argument order setInt16', () => {
  try {
    view.setInt16((order.push('offset'), Symbol('1')), (order.push('value'), 1), (order.push('le'), true));
  } finally {
    console.log('order: ' + order.join(','));
  }
});

// Numeric offsets still work, and a Symbol is the only value that throws
// here: a string, an object with valueOf, and undefined all convert.
report('number offset', () => view.getInt8(2));
report('string offset', () => view.getInt8('2'));
report('undefined offset', () => view.getInt16(undefined));
view.setFloat64(0, 1.5);
console.log('roundtrip: ' + view.getFloat64(0));

// Node evaluates a member call's receiver and every argument before any
// conversion runs, so the later effects happen even though the Symbol
// offset's ToIndex throws. The BigInt kinds convert the same way.
function sequence(label, fn) {
  const steps = [];
  try {
    fn(steps);
    steps.push('no throw');
  } catch (e) {
    steps.push(e.name + ': ' + e.message);
  }
  console.log(label + ': ' + steps.join(','));
}

sequence('bigint getter littleEndian effect', (steps) =>
  view.getBigInt64((steps.push('offset'), Symbol('1')), (steps.push('le'), true)),
);
sequence('bigint setter littleEndian effect', (steps) =>
  view.setBigInt64((steps.push('offset'), Symbol('1')), 1n, (steps.push('le'), true)),
);
sequence('bigint setter value effect', (steps) =>
  view.setBigUint64((steps.push('offset'), Symbol('1')), (steps.push('value'), 1n)),
);
sequence('bigint getter fresh view', (steps) =>
  new DataView(buffer).getBigInt64((steps.push('offset'), Symbol('1')), (steps.push('le'), false)),
);
sequence('numeric setter receiver effect', (steps) => {
  const pick = () => (steps.push('receiver'), view);
  pick().setFloat64(Symbol('1'), (steps.push('value'), 1));
});
sequence('numeric getter receiver effect', (steps) => {
  const pick = () => (steps.push('receiver'), view);
  pick().getInt16((steps.push('offset'), Symbol('1')), (steps.push('le'), true));
});
sequence('numeric setter value effect', (steps) => {
  const pick = () => (steps.push('receiver'), view);
  pick().setInt32((steps.push('offset'), 0), (steps.push('value'), Symbol('1')));
});
console.log('view intact: ' + view.getFloat64(0));
