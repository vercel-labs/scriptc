// A JavaScript module that keeps process-wide state on the global object
// under a symbol, the way packages share a singleton between copies of
// themselves and a launcher shares marks with the program it starts. The
// bindings are read from functions declared beside them, so each has to be
// the module's own storage, not a value the module's start alone can see.
const STARTUP = Symbol.for('corpus.9405.startup');
const launched = STARTUP in globalThis;
const startup = launched
  ? globalThis[STARTUP]
  : process.env.CORPUS_9405_DISABLED
    ? undefined
    : { marks: [{ phase: 'first', at: 1 }] };
if (!launched) Reflect.set(globalThis, STARTUP, startup);
function mark(phase) {
  startup?.marks.push({ phase, at: startup.marks.length + 1 });
}
mark('second');
mark('third');
console.log(
  launched,
  startup.marks.map((m) => m.phase + m.at).join(','),
  globalThis[STARTUP] === startup,
);

// A conditional with a literal arm, and one with an `undefined` arm.
const STATE = Symbol.for('corpus.9405.state');
const state = STATE in globalThis ? globalThis[STATE] : { names: ['a'] };
function addName(name) {
  state.names.push(name);
  return state.names.length;
}
const absent = process.env.CORPUS_9405_DISABLED ? undefined : globalThis[Symbol.for('corpus.9405.none')];
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
