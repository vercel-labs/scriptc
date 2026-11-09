// One object, reached many ways, is one key: as a Map key, a Set member, under `===` and
// Object.is, as a WeakMap key and a WeakSet member, for indexOf, lastIndexOf and includes of
// an array, and for assert.strictEqual. Each kind of object is held under its static type and
// behind an untyped value, from a local, a field, an element, a collection and a closure,
// before and after a boxing. A second object of the same kind is never found. Every line
// counts the ways that answered as one object; under Node each count is full.
import assert from 'node:assert';

type Note = {key: number; who: string};

class Cell<T> {
  v: T;
  constructor(v: T) {
    this.v = v;
  }
}

class Thing {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class Sub extends Thing {
  extra = 'x';
}

function identity<T>(v: T): T {
  return v;
}

async function delayed<T>(v: T): Promise<{v: T}> {
  await Promise.resolve();
  return {v};
}

let lines = 0;
let misses = 0;

function part(parts: string[], name: string, hits: number, of: number): void {
  parts.push(name + ' ' + hits + '/' + of);
  if (hits !== of) misses++;
}

function flag(parts: string[], name: string, got: boolean, want: boolean): void {
  parts.push(name + ' ' + got);
  if (got !== want) misses++;
}

function typedChecks<T>(other: T, ways: T[]): string {
  const parts: string[] = [];
  const n = ways.length;
  const map = new Map<T, number>();
  map.set(ways[0], 7);
  let has = 0;
  let got = 0;
  for (const w of ways) {
    if (map.has(w)) has++;
    if (map.get(w) === 7) got++;
  }
  for (const w of ways) map.set(w, 8);
  part(parts, 'map.has', has, n);
  part(parts, 'map.get', got, n);
  part(parts, 'map.size', map.size, 1);
  flag(parts, 'map.has(other)', map.has(other), false);
  flag(parts, 'map.delete', map.delete(ways[n - 1]), true);
  const set = new Set<T>();
  set.add(ways[0]);
  let member = 0;
  for (const w of ways) {
    if (set.has(w)) member++;
  }
  for (const w of ways) set.add(w);
  part(parts, 'set.has', member, n);
  part(parts, 'set.size', set.size, 1);
  flag(parts, 'set.has(other)', set.has(other), false);
  flag(parts, 'set.delete', set.delete(ways[n - 1]), true);
  let strict = 0;
  let notStrict = 0;
  for (const a of ways) {
    for (const b of ways) {
      if (a === b) strict++;
      if (a !== b) notStrict++;
    }
  }
  part(parts, '===', strict, n * n);
  part(parts, '!==', notStrict, 0);
  flag(parts, 'other ===', other === ways[0], false);
  const list: T[] = [other, ways[0], other];
  let index = 0;
  let last = 0;
  let includes = 0;
  let found = 0;
  for (const w of ways) {
    if (list.indexOf(w) === 1) index++;
    if (list.lastIndexOf(w) === 1) last++;
    if (list.includes(w)) includes++;
    if (list.findIndex(x => x === w) === 1) found++;
  }
  part(parts, 'indexOf', index, n);
  part(parts, 'lastIndexOf', last, n);
  part(parts, 'includes', includes, n);
  part(parts, 'findIndex', found, n);
  return parts.join(', ');
}

function isChecks<T>(other: T, ways: T[]): string {
  const parts: string[] = [];
  let is = 0;
  for (const a of ways) {
    for (const b of ways) {
      if (Object.is(a, b)) is++;
    }
  }
  part(parts, 'Object.is', is, ways.length * ways.length);
  flag(parts, 'Object.is(other)', Object.is(other, ways[0]), false);
  return parts.join(', ');
}

function weakChecks<T extends WeakKey>(other: T, ways: T[]): string {
  const parts: string[] = [];
  const n = ways.length;
  const weak = new WeakMap<T, number>();
  weak.set(ways[0], 7);
  let has = 0;
  let got = 0;
  for (const w of ways) {
    if (weak.has(w)) has++;
    if (weak.get(w) === 7) got++;
  }
  part(parts, 'weakmap.has', has, n);
  part(parts, 'weakmap.get', got, n);
  flag(parts, 'weakmap.has(other)', weak.has(other), false);
  flag(parts, 'weakmap.delete', weak.delete(ways[n - 1]), true);
  flag(parts, 'weakmap.has after', weak.has(ways[0]), false);
  const members = new WeakSet<T>();
  members.add(ways[0]);
  let member = 0;
  for (const w of ways) {
    if (members.has(w)) member++;
  }
  part(parts, 'weakset.has', member, n);
  flag(parts, 'weakset.has(other)', members.has(other), false);
  flag(parts, 'weakset.delete', members.delete(ways[n - 1]), true);
  return parts.join(', ');
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

// The same checks with every key behind an untyped value.
function untypedChecks(other: unknown, ways: unknown[], weak: boolean): string {
  const parts: string[] = [];
  const n = ways.length;
  parts.push(typedChecks<unknown>(other, ways));
  parts.push(isChecks<unknown>(other, ways));
  const first = ways[0];
  if (isObject(first) && isObject(other)) {
    const objects = new Map<object, number>();
    const objectSet = new Set<object>();
    objects.set(first, 7);
    objectSet.add(first);
    let has = 0;
    let member = 0;
    for (const w of ways) {
      if (isObject(w)) {
        if (objects.get(w) === 7) has++;
        if (objectSet.has(w)) member++;
        objects.set(w, 7);
        objectSet.add(w);
      }
    }
    part(parts, 'Map<object>.get', has, n);
    part(parts, 'Map<object>.size', objects.size, 1);
    part(parts, 'Set<object>.has', member, n);
    part(parts, 'Set<object>.size', objectSet.size, 1);
    flag(parts, 'Map<object>.has(other)', objects.has(other), false);
    if (weak) {
      const weakWays: object[] = [];
      for (const w of ways) {
        if (isObject(w)) weakWays.push(w);
      }
      parts.push(weakChecks<object>(other, weakWays));
    }
  }
  const anyMap = new Map<any, number>();
  const anyFirst: any = ways[0];
  anyMap.set(anyFirst, 7);
  let anyHas = 0;
  for (const w of ways) {
    const a: any = w;
    if (anyMap.get(a) === 7) anyHas++;
  }
  part(parts, 'Map<any>.get', anyHas, n);
  let asserted = 0;
  for (const w of ways) {
    try {
      assert.strictEqual(w, ways[0]);
      assert.notStrictEqual(w, other);
      asserted++;
    } catch {
      misses++;
    }
  }
  part(parts, 'assert.strictEqual', asserted, n);
  return parts.join(', ');
}

const everything = new Map<unknown, string>();
const everyObject = new Set<unknown>();

function report(name: string, typed: string, weak: string, untyped: string, ways: unknown[], other: unknown): void {
  lines++;
  console.log(name + ' typed: ' + typed);
  if (weak !== '') console.log(name + ' weak: ' + weak);
  console.log(name + ' untyped: ' + untyped);
  // One table for every kind: a key never answers for another kind's key.
  let seen = 0;
  if (!everything.has(ways[0])) everything.set(ways[0], name);
  for (const w of ways) {
    if (everything.get(w) === everything.get(ways[0])) seen++;
    everyObject.add(w);
  }
  if (!everything.has(other)) everything.set(other, name + ' (other)');
  everyObject.add(other);
  console.log(name + ' shared table: ' + seen + '/' + ways.length + ' as ' + everything.get(ways[0]) + ', sizes ' + everything.size + ' ' + everyObject.size);
}

// Every way of reaching `v`, typed and untyped.
async function gather<T>(v: T): Promise<{typed: T[]; untyped: unknown[]}> {
  const maybe: T | null = v;
  const optional: T | undefined = v;
  const boxed: unknown = v;
  const anyV: any = v;
  const holder: {v: T} = {v};
  const optHolder: {v?: T} = {v};
  const cell = new Cell<T>(v);
  const list: T[] = [v];
  const pair: [T, number] = [v, 1];
  const byName = new Map<string, T>();
  byName.set('k', v);
  const members = new Set<T>();
  members.add(v);
  const capture = (): T => v;
  const later = await delayed(holder);
  const typedWays: T[] = [v];
  if (maybe !== null) typedWays.push(maybe);
  if (optional !== undefined) typedWays.push(optional);
  typedWays.push(holder.v, cell.v, list[0], pair[0], capture(), identity(v), boxed as T, anyV as T, (v as unknown) as T, later.v.v);
  const fromMap = byName.get('k');
  if (fromMap !== undefined) typedWays.push(fromMap);
  if (optHolder.v !== undefined) typedWays.push(optHolder.v);
  for (const m of members) typedWays.push(m);
  const {v: taken} = holder;
  typedWays.push(taken);
  const untypedWays: unknown[] = [
    v,
    maybe,
    optional,
    boxed,
    boxed,
    anyV,
    holder.v,
    cell.v,
    list[0],
    pair[0],
    capture(),
    identity(v),
    boxed as T,
    later.v.v,
    byName.get('k'),
    optHolder.v,
    identity<unknown>(v),
    v,
  ];
  for (const w of typedWays) untypedWays.push(w);
  return {typed: typedWays, untyped: untypedWays};
}

async function reach<T extends WeakKey>(name: string, v: T, other: T, weak: boolean): Promise<void> {
  const ways = await gather<T>(v);
  const otherUntyped: unknown = other;
  const typed = typedChecks<T>(other, ways.typed) + ', ' + isChecks<T>(other, ways.typed);
  report(name, typed, weak ? weakChecks<T>(other, ways.typed) : '', untypedChecks(otherUntyped, ways.untyped, weak), ways.untyped, otherUntyped);
}

// A kind that is no key of a typed collection and no element of a typed array: `===` under
// its static type, and every collection behind an untyped value.
async function reachLoose<T extends WeakKey>(name: string, v: T, other: T, weak: boolean): Promise<void> {
  const maybe: T | null = v;
  const boxed: unknown = v;
  const anyV: any = v;
  const holder: {v: T} = {v};
  const cell = new Cell<T>(v);
  const capture = (): T => v;
  const later = await delayed(holder);
  const parts: string[] = [];
  let strict = 0;
  if (v === holder.v) strict++;
  if (holder.v === cell.v) strict++;
  if (cell.v === capture()) strict++;
  if (capture() === identity(v)) strict++;
  if (identity(v) === later.v.v) strict++;
  if (maybe === v) strict++;
  part(parts, '===', strict, 6);
  flag(parts, 'other ===', other === v, false);
  const untypedWays: unknown[] = [v, maybe, boxed, boxed, anyV, holder.v, cell.v, capture(), identity(v), later.v.v, identity<unknown>(v), v];
  const otherUntyped: unknown = other;
  report(name, parts.join(', '), '', untypedChecks(otherUntyped, untypedWays, weak), untypedWays, otherUntyped);
}

// A value kind: equal values are one key, whichever box holds them.
function reachValue<T>(name: string, v: T, same: T, other: T): void {
  const boxed: unknown = v;
  const holder: {v: T} = {v};
  const typedWays: T[] = [v, same, holder.v, boxed as T, identity(v)];
  const untypedWays: unknown[] = [v, same, boxed, holder.v, boxed as T, identity<unknown>(same)];
  const otherUntyped: unknown = other;
  report(name, typedChecks<T>(other, typedWays), '', untypedChecks(otherUntyped, untypedWays, false), untypedWays, otherUntyped);
}

function declared(x: number): number {
  return x + 1;
}

async function asyncDeclared(): Promise<number> {
  return 1;
}

async function main(): Promise<void> {
  const note: Note = {key: 1, who: 'ada'};

  // Records, arrays and class instances.
  await reach<Note>('record', note, {key: 1, who: 'ada'}, true);
  await reach<{}>('empty record', {}, {}, true);
  await reach<{tag: symbol}>('record with a symbol', {tag: Symbol('t')}, {tag: Symbol('t')}, true);
  await reach<{next?: Note}>('record with an optional field', {}, {}, true);
  await reach<Record<string, number>>('index record', {a: 1}, {a: 1}, true);
  await reach<Note[]>('array of records', [note], [note], true);
  await reach<number[]>('array of numbers', [1, 2], [1, 2], true);
  await reach<string[]>('array of strings', ['a'], ['a'], true);
  await reach<ReadonlyArray<Note>>('readonly array', [note], [note], true);
  await reach<[number, string]>('tuple', [1, 'a'], [1, 'a'], true);
  await reach<unknown[]>('array of unknown', [1, 'a'], [1, 'a'], true);
  await reach<Thing>('class instance', new Thing(1), new Thing(1), true);
  await reach<Thing>('subclass instance as its base', new Sub(1), new Sub(1), true);
  await reach<Sub>('subclass instance', new Sub(2), new Sub(2), true);
  await reach<{id: number}>('class instance as a record', new Thing(3), new Thing(3), true);
  await reach<Cell<Note>>('generic class instance', new Cell<Note>(note), new Cell<Note>(note), true);

  // Functions.
  const arrow = (x: number): number => x + 1;
  const captured = (x: number): number => x + note.key;
  await reach<(x: number) => number>('arrow function', arrow, (x: number): number => x + 1, true);
  await reach<(x: number) => number>('closure', captured, (x: number): number => x + note.key, true);
  await reach<(x: number) => number>('function declaration', declared, arrow, true);
  await reach<() => Promise<number>>('async function', asyncDeclared, async (): Promise<number> => 1, true);
  await reachLoose<typeof Thing>('class constructor', Thing, Sub, true);
  await reach<(x: number) => unknown>('function at a wider type', arrow, captured, true);

  // Values: equal values are one key.
  const sym = Symbol('s');
  reachValue<symbol>('symbol', sym, sym, Symbol('s'));
  reachValue<symbol>('registered symbol', Symbol.for('r'), Symbol.for('r'), Symbol.for('q'));
  reachValue<symbol>('well-known symbol', Symbol.iterator, Symbol.iterator, Symbol.asyncIterator);
  reachValue<bigint>('bigint', 12345678901234567890n, 12345678901234567890n, 12345678901234567891n);
  reachValue<bigint>('small bigint', 5n, 2n + 3n, 6n);
  reachValue<string>('string', 'key', ['k', 'ey'].join(''), 'kex');
  reachValue<number>('number', 1.5, 3 / 2, 2.5);
  reachValue<boolean>('boolean', true, !false, false);

  console.log('kinds ' + lines + ', misses ' + misses);
}

main();
