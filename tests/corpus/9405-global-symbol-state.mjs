// File-scope bindings of a JavaScript module whose value comes out of the
// global object's symbol store (`globalThis[KEY]`, beside `in` and Reflect),
// read by functions the module declares. A function declaration is lowered
// apart from the module's start, so it reaches such a binding only when the
// binding is storage of the module; a local of the start is out of its reach.

// A kiln log: taken from the global object when one is registered there,
// started here otherwise, and registered with Reflect.set either way.
const KILN = Symbol.for('corpus.9405.kiln');
const kiln = !(KILN in globalThis) ? { firings: ['bisque'], peak: 600 } : globalThis[KILN];
console.log(KILN in globalThis, Reflect.set(globalThis, KILN, kiln), KILN in globalThis);
function fire(glaze, degrees) {
  kiln.firings.push(glaze);
  if (degrees > kiln.peak) kiln.peak = degrees;
  return kiln.firings.length;
}
function kilnReport() {
  return kiln.firings.join('>') + ' peak ' + kiln.peak;
}
console.log(fire('celadon', 1240), fire('raku', 980), kilnReport(), Reflect.get(globalThis, KILN) === kiln);

// The registered log read back through a nested logical expression, and a
// literal whose other arm is `undefined`.
const sameKiln = (KILN in globalThis && globalThis[KILN]) || { firings: [], peak: 0 };
const spareShelf = kiln.peak > 5000 ? undefined : { cones: [6, 10] };
function shelfReport() {
  const cones = spareShelf === undefined ? 'no shelf' : spareShelf.cones.join('/');
  return cones + ' ' + sameKiln.firings.length + ' ' + (sameKiln === kiln);
}
console.log(shelfReport());

// A conditional with a literal arm, and one with an `undefined` arm.
const STATE = Symbol.for('corpus.9405.state');
const state = STATE in globalThis ? globalThis[STATE] : { names: ['a'] };
function addName(name) {
  state.names.push(name);
  return state.names.length;
}
const absent = process.argv.length > 99 ? undefined : globalThis[Symbol.for('corpus.9405.none')];
function describeAbsent() {
  return absent === undefined ? 'none' : typeof absent;
}
console.log(addName('b'), addName('c'), state.names.join(''), describeAbsent());

// `??` and `||` over the read, and the read alone.
const CACHE = Symbol.for('corpus.9405.cache');
const cache = globalThis[CACHE] ?? { hits: 0 };
function hit() {
  cache.hits += 1;
  return cache.hits;
}
const OTHER = Symbol.for('corpus.9405.other');
const other = globalThis[OTHER] || (globalThis[OTHER] = { n: 10 });
function bump() {
  other.n += 1;
  return other.n === globalThis[OTHER].n;
}
globalThis[Symbol.for('corpus.9405.plain')] = ['x'];
const plain = globalThis[Symbol.for('corpus.9405.plain')];
function grow() {
  plain.push('y');
  return plain.join('');
}
console.log(hit(), hit(), CACHE in globalThis, bump(), other.n, grow());

// The singleton idiom: `??=` on the global slot, as a value and as a statement.
const REGISTRY = Symbol.for('corpus.9405.registry');
const registry = (globalThis[REGISTRY] ??= new Map());
function register(key, value) {
  registry.set(key, value);
  return registry.size;
}
function shared() {
  return (globalThis[REGISTRY] ??= new Map());
}
console.log(register('a', 1), register('b', 2), shared() === registry, [...shared().keys()].join(','));
const COUNTER = Symbol.for('corpus.9405.counter');
globalThis[COUNTER] ??= { count: 0 };
globalThis[COUNTER] ??= { count: 100 };
const counter = globalThis[COUNTER];
function count() {
  counter.count += 1;
  return counter.count;
}
console.log(count(), count(), JSON.stringify(globalThis[COUNTER]));

// A module-level symbol, `in`, Reflect, a descriptor, functions held there,
// and symbols that reach the access through an untyped binding.
const PRIVATE = Symbol('corpus.9405.private');
console.log(PRIVATE in globalThis, globalThis[PRIVATE]);
globalThis[PRIVATE] = { calls: 0, twice(x) { this.calls += 1; return x * 2; } };
console.log(
  PRIVATE in globalThis,
  globalThis[PRIVATE].twice(4),
  globalThis[PRIVATE].calls,
  Object.getOwnPropertySymbols(globalThis).includes(PRIVATE),
);
const DEFINED = Symbol.for('corpus.9405.defined');
Object.defineProperty(globalThis, DEFINED, { value: { n: 7 }, enumerable: false, writable: false, configurable: true });
const descriptor = Object.getOwnPropertyDescriptor(globalThis, DEFINED);
console.log(
  globalThis[DEFINED].n,
  descriptor.enumerable,
  descriptor.writable,
  Reflect.has(globalThis, DEFINED),
  Reflect.get(globalThis, DEFINED).n,
  Reflect.deleteProperty(globalThis, DEFINED),
  DEFINED in globalThis,
);
const keys = [Symbol.for('corpus.9405.k1'), Symbol.for('corpus.9405.k2')];
for (const key of keys) globalThis[key] = key.description;
console.log(keys.map((key) => globalThis[key]).join(','), keys.every((key) => key in globalThis));
global[Symbol.for('corpus.9405.alias')] = 'through global';
console.log(globalThis[Symbol.for('corpus.9405.alias')], typeof globalThis[Symbol.for('corpus.9405.nothing')]);
