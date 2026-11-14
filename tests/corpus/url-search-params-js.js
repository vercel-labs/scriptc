// URLSearchParams from an untyped JavaScript source: the constructor's
// WHATWG init algorithm over values a typed program cannot spell (a Set, a
// Map, a generator, an array of non-pairs), the ternaries' USVString
// conversions, the argument checks of the readers and mutators, forEach's
// thisArg, and the coercions String() and friends perform on the object.
'use strict';

function observe(label, fn) {
  try {
    console.log(label, '=>', JSON.stringify(fn()));
  } catch (e) {
    console.log(label, 'throw', e.name, e.code, e.message);
  }
}

// The primitive inits: null and every other primitive take the string
// branch, so their ToString is parsed (null is "null", not "no init").
const primitiveInits = [undefined, null, 7, -0, 1.5, true, false, 'a=1', '?b=2', String('c=3')];
for (const init of primitiveInits) {
  observe('init ' + String(init), () => new URLSearchParams(init).toString());
}

// Array rows: only [name, value] arrays are pairs; another arity, a
// non-array row (a string, a Set, an array-like object) is a TypeError.
const rowInits = [
  ['a', 'b'],
  [['a', '1'], ['b', '2']],
  [[1, 2]],
  [['a']],
  [['a', 'b', 'c']],
  [{ 0: 'a', 1: 'b', length: 2 }],
  [new Set(['a', 'b'])],
  ['ab'],
  [null],
  [undefined],
  [1],
  [['a', ['x', 'y']]],
  [],
];
for (const init of rowInits) {
  observe('rows ' + JSON.stringify(init), () => new URLSearchParams(init).toString());
}

// Any iterable is a sequence of pair rows; a row may itself be any iterable
// with exactly two elements.
observe('set of pairs', () => new URLSearchParams(new Set([['a', '1'], ['b', '2']])).toString());
observe('map', () => new URLSearchParams(new Map([['a', '1'], ['b', '2']])).toString());
observe('map empty', () => new URLSearchParams(new Map()).toString());
observe('map numeric', () => new URLSearchParams(new Map([[1, 2]])).toString());
function* pairs() {
  yield ['a', '1'];
  yield ['b', '2'];
}
observe('generator', () => new URLSearchParams(pairs()).toString());
function* rows() {
  yield 'x';
}
observe('generator bad row', () => new URLSearchParams(rows()).toString());
function* two() {
  yield 'k';
  yield 'v';
}
function* one() {
  yield 'k';
}
function* three() {
  yield 'k';
  yield 'v';
  yield 'w';
}
// The rows are built in variables: a literal argument here would be
// contextually typed as the constructor's declared string[][] arm, which
// is a compile-time refusal rather than the runtime behavior under test.
const generatorRows = [[two()], [one()], [three()]];
const generatorLabels = ['generator row', 'generator row short', 'generator row long'];
for (let i = 0; i < generatorRows.length; i++) {
  const row = generatorRows[i];
  observe(generatorLabels[i], () => new URLSearchParams(row).toString());
}
observe('bytes', () => new URLSearchParams(new Uint8Array([1, 2])).toString());
observe('buffer', () => new URLSearchParams(Buffer.from('a=1')).toString());

// An object without a Symbol.iterator is a record of own enumerable keys;
// values go through ToString, so nested objects and arrays print their
// join form.
observe('empty object', () => new URLSearchParams({}).toString());
observe('record values', () =>
  new URLSearchParams({ a: 1, b: true, c: null, d: undefined, e: 1.5, f: -0 }).toString());
observe('record nested', () => new URLSearchParams({ a: { b: 'c' }, d: ['e', 'f'] }).toString());
observe('record order', () => new URLSearchParams({ z: '1', a: '2', m: '3' }).toString());
observe('record index keys', () => new URLSearchParams({ 2: 'c', 0: 'a', 1: 'b' }).toString());
observe('array-like', () => new URLSearchParams({ length: 2, 0: 'a', 1: 'b' }).toString());
const inherited = Object.create({ inherited: '1' });
inherited.own = '2';
observe('inherited', () => new URLSearchParams(inherited).toString());
const getter = {};
Object.defineProperty(getter, 'k', { enumerable: true, get: () => 'v' });
observe('getter', () => new URLSearchParams(getter).toString());
const hidden = { a: '1' };
Object.defineProperty(hidden, 'b', { enumerable: false, value: '2' });
observe('non-enumerable', () => new URLSearchParams(hidden).toString());
observe('function', () => new URLSearchParams(function named() {}).toString());
observe('symbol key', () => {
  const record = { a: '1' };
  record[Symbol('s')] = '2';
  return new URLSearchParams(record).toString();
});

// Objects that are not records of pairs: a URL, a Date and a RegExp have
// no own enumerable strings, so they make the empty list.
observe('url object', () => new URLSearchParams(new URL('https://a/?b=1')).toString());
observe('date', () => new URLSearchParams(new Date(0)).toString());
observe('regexp', () => new URLSearchParams(/a=1/).toString());
observe('error', () => new URLSearchParams(Object.assign(new Error('e'), { a: '1' })).toString());

// A copy is independent; string coercion of the object prints the list.
const source = new URLSearchParams('k=1&k=2');
const copy = new URLSearchParams(source);
copy.append('k', '3');
observe('copy', () => [copy.toString(), source.toString()]);
observe('String', () => String(new URLSearchParams('a=1&b=2')));
observe('template', () => `${new URLSearchParams('a=1')}`);
observe('concat', () => '' + new URLSearchParams('a=1'));

// The readers and mutators convert their arguments and report a missing
// one as ERR_MISSING_ARGS before converting anything.
const params = new URLSearchParams('a=1&a=2&b=x+y&d=');
observe('get', () => [params.get('a'), params.get('zzz'), params.get(null), params.get(undefined)]);
observe('get extra', () => params.get('a', 'b'));
observe('get missing', () => params.get());
observe('getAll missing', () => params.getAll());
observe('has missing', () => params.has());
observe('has value', () => [params.has('a', '1'), params.has('a', '9'), params.has('d', '')]);
observe('delete missing', () => params.delete());
observe('set missing', () => new URLSearchParams().set('a'));
observe('set none', () => new URLSearchParams().set());
observe('append missing', () => new URLSearchParams().append('a'));
observe('append null', () => {
  const list = new URLSearchParams();
  list.append(null, null);
  return list.toString();
});
observe('set undefined', () => {
  const list = new URLSearchParams();
  list.set(undefined, undefined);
  return list.toString();
});
observe('size', () => params.size);
observe('sort extra', () => new URLSearchParams('b=1&a=2').sort('x') === undefined);

// forEach: the callback arity selects its arguments, thisArg binds this,
// a non-function callback is a TypeError, and appends during the walk are
// visited.
observe('forEach thisArg', () => {
  const tally = { hits: 0 };
  params.forEach(function (value) {
    this.hits += value.length;
  }, tally);
  return tally.hits;
});
observe('forEach missing', () => params.forEach());
observe('forEach number', () => params.forEach(1));
observe('forEach live', () => {
  const list = new URLSearchParams('a=1');
  const seen = [];
  list.forEach((value, name) => {
    seen.push(name);
    if (seen.length < 3) list.append(name + 'x', value);
  });
  return [seen.join(','), list.size];
});

// The default iterator and the three views share the live list; a stored
// iterator sees later appends.
const view = new URLSearchParams('a=1&b=2&a=3');
observe('entries', () => [...view.entries()].map((pair) => pair.join('=')).join('&'));
observe('keys', () => [...view.keys()].join(','));
observe('values', () => [...view.values()].join(','));
observe('default', () => [...view].map((pair) => pair[0] + ':' + pair[1]).join(','));
observe('symbol iterator', () => [...view[Symbol.iterator]()].map((pair) => pair.join('=')).join('&'));
observe('spread', () => JSON.stringify([...new URLSearchParams('t=1')]));
observe('steps', () => {
  const iterator = view.entries();
  return [JSON.stringify(iterator.next()), JSON.stringify(iterator.next())];
});
const live = new URLSearchParams('a=1&b=2');
const walker = live.values();
observe('live first', () => walker.next().value);
live.append('c', '3');
observe('live rest', () => [...walker].join(','));
