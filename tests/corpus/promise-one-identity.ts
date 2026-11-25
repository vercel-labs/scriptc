// A promise is one object however the program holds it. A promise with a typed settled
// value enters an untyped position as another adapter each time; every adapter is the
// promise it adapts: as the key of an untyped Map or Set, in a union, for Object.is, for the
// searches of an array, for assert's comparisons, in a switch, and when a promise is
// resolved with itself.
import assert from 'node:assert';

type Note = {key: number; who: string};

class Holder {
  one: Promise<Note>;
  maybe: Promise<Note> | null;
  constructor(one: Promise<Note>, maybe: Promise<Note> | null) {
    this.one = one;
    this.maybe = maybe;
  }
}

const seen = new Map<object, string>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

// The promise arrives untyped: each call boxes it again.
function note(value: unknown): string {
  if (!isObject(value)) return 'plain';
  const had = seen.get(value);
  if (had !== undefined) return 'seen as ' + had;
  const name = 'n' + seen.size;
  seen.set(value, name);
  return 'new ' + name;
}

function same(a: unknown, b: unknown): boolean {
  return a === b;
}

function unionChecks<T>(name: string, other: T, ways: T[]): void {
  const map = new Map<T, number>();
  const set = new Set<T>();
  map.set(ways[0], 7);
  set.add(ways[0]);
  let has = 0;
  let member = 0;
  let strict = 0;
  let is = 0;
  for (const a of ways) {
    if (map.get(a) === 7) has++;
    if (set.has(a)) member++;
    for (const b of ways) {
      if (a === b) strict++;
      if (Object.is(a, b)) is++;
    }
  }
  for (const a of ways) {
    map.set(a, 8);
    set.add(a);
  }
  console.log(
    name + ': of ' + ways.length + ': map ' + has + ' size ' + map.size + ', set ' + member + ' size ' + set.size + ', === ' + strict + ', Object.is ' + is +
      ' | other ' + map.has(other) + ' ' + set.has(other) + ' ' + (other === ways[0]) + ' ' + Object.is(other, ways[0]),
  );
}

function searches<T>(name: string, other: T, ways: T[]): void {
  const list: T[] = [other, ways[0], other];
  let index = 0;
  let includes = 0;
  let last = 0;
  let from = 0;
  for (const a of ways) {
    if (list.indexOf(a) === 1) index++;
    if (list.includes(a)) includes++;
    if (list.lastIndexOf(a) === 1) last++;
    if (list.indexOf(a, 1) === 1 && list.includes(a, 1) && list.indexOf(a, 2) === -1) from++;
  }
  console.log(name + ': of ' + ways.length + ': indexOf ' + index + ', includes ' + includes + ', lastIndexOf ' + last + ', from an index ' + from + ' | other ' + list.indexOf(other) + ' ' + list.lastIndexOf(other));
}

function tried(name: string, run: () => void): void {
  try {
    run();
    console.log(name + ': passes');
  } catch (error) {
    console.log(name + ': throws ' + (error instanceof Error ? error.name : 'a value'));
  }
}

async function main(): Promise<void> {
  const record: Note = {key: 1, who: 'ada'};
  const promise: Promise<Note> = Promise.resolve(record);
  const second: Promise<Note> = Promise.resolve(record);
  const holder = new Holder(promise, promise);

  // The reported program: one promise handed over untyped from several typed places.
  console.log('promise in a Map: ' + note(holder.one) + ' | ' + note(holder.maybe) + ' | ' + note(promise) + ' | ' + note(holder.one));
  console.log('another promise: ' + note(second) + ' | ' + note(second));
  console.log('under ===: ' + (holder.one === holder.maybe) + ' | ' + same(holder.one, holder.maybe) + ' | ' + same(holder.one, second));
  const fresh: Promise<Note> = new Promise(resolve => {
    resolve(record);
  });
  const freshMaybe: Promise<Note> | null = fresh;
  console.log('a promise made by its constructor: ' + note(fresh) + ' | ' + note(freshMaybe) + ' | ' + same(fresh, freshMaybe));
  async function load(): Promise<Note> {
    return record;
  }
  const loaded = load();
  const loadedMaybe: Promise<Note> | null = loaded;
  console.log('a promise of an async function: ' + note(loaded) + ' | ' + note(loadedMaybe) + ' | ' + same(loaded, loadedMaybe));
  await loaded;
  console.log('once it has settled: ' + note(loaded) + ' | ' + note(promise));
  console.log('the promise of then is another: ' + note(promise.then(n => n.key)) + ' | ' + note(promise));

  // The same promise given directly to an untyped collection.
  const boxed: unknown = promise;
  const boxedAgain: unknown = holder.one;
  const back = boxed as Promise<Note>;
  const objects = new Map<object, string>();
  objects.set(promise, 'typed');
  console.log('given directly: ' + objects.get(back) + ' ' + objects.get(holder.one) + ' ' + objects.has(second) + ' ' + objects.size + ' ' + (isObject(boxed) ? objects.get(boxed) : 'plain'));
  objects.set(back, 'again');
  console.log('set again: ' + objects.size + ' ' + objects.get(promise) + ' ' + objects.delete(holder.one) + ' ' + objects.size);
  const dedupe = new Set<unknown>([promise, back, boxed, boxedAgain, second]);
  console.log('a set of an array: ' + dedupe.size + ' ' + dedupe.has(holder.maybe) + ' ' + dedupe.has(record));
  const list: unknown[] = [promise, back, boxed, second, promise];
  console.log('a set of an untyped array: ' + new Set(list).size + ' ' + [...new Set(list)].length);
  const keyed = new Map<unknown, string>([
    [promise, 'a'],
    [back, 'b'],
    [second, 'c'],
  ]);
  console.log('a map of pairs: ' + keyed.size + ' ' + keyed.get(boxed) + ' ' + keyed.get(second) + ' ' + keyed.get(holder.maybe));
  for (const [key, value] of keyed) {
    console.log('a key read back: ' + value + ' ' + (key === promise) + ' ' + (key === boxed) + ' ' + (key === second));
  }
  const values = new Map<string, unknown>();
  values.set('p', promise);
  console.log('a value read back: ' + (values.get('p') === boxed) + ' ' + (values.get('p') === promise) + ' ' + (values.get('p') === second));
  const failed: Promise<Note> = Promise.reject(new Error('no'));
  failed.catch(() => {});
  const failures = new Set<unknown>();
  failures.add(failed);
  failures.add(failed);
  console.log('a rejected promise: ' + failures.size + ' ' + failures.has(failed) + ' ' + failures.has(promise));

  // A typed collection behind an untyped value.
  const typedKeys = new Map<Promise<Note>, string>([
    [promise, 'a'],
    [second, 'c'],
  ]);
  const viewed: unknown = typedKeys;
  if (viewed instanceof Map) {
    console.log('a typed map behind an untyped value: ' + viewed.size + ' ' + viewed.has(boxed) + ' ' + viewed.get(boxedAgain) + ' ' + viewed.has(record));
  }
  const typedSet = new Set<Promise<Note>>([promise]);
  const viewedSet: unknown = typedSet;
  if (viewedSet instanceof Set) {
    console.log('a typed set behind an untyped value: ' + viewedSet.has(boxed) + ' ' + viewedSet.has(second as unknown));
    viewedSet.add(boxedAgain);
    console.log('after adding the same promise untyped: ' + typedSet.size);
  }

  // A promise in a union.
  const again = (promise as unknown) as Promise<Note>;
  const maybe: Promise<Note> | null = promise;
  const optional: Promise<Note> | undefined = back;
  const fields: {p: Promise<Note>; q: Promise<Note> | null} = {p: promise, q: back};
  unionChecks<Promise<Note>>('promise', second, [promise, back, again, fields.p]);
  unionChecks<Promise<Note> | null>('promise or null', second, [promise, maybe, back, again, fields.p, fields.q]);
  unionChecks<Promise<Note> | null>('promise or null against null', null, [promise, maybe, back, again, fields.p, fields.q]);
  unionChecks<Promise<Note> | undefined>('promise or undefined', second, [promise, optional, back, again]);
  unionChecks<Promise<Note> | Note>('promise or record', record, [promise, back, again, fields.p]);
  unionChecks<Promise<Note> | string>('promise or string', 'p', [promise, back, again, fields.p]);
  unionChecks<Promise<Note> | number | null>('promise, number or null', 1, [promise, back, again, fields.p]);
  unionChecks<Promise<Note> | Promise<number>>('one of two promises', Promise.resolve(1), [promise, back, again, fields.p]);
  unionChecks<Promise<Note> | (() => void)>('promise or function', () => {}, [promise, back, again, fields.p]);
  searches<Promise<Note>>('promise', second, [promise, back, again, fields.p]);
  searches<Promise<Note> | null>('promise or null', second, [promise, maybe, back, again, fields.p, fields.q]);
  searches<Promise<Note> | null>('promise or null against null', null, [promise, maybe, back, again, fields.p, fields.q]);
  searches<Promise<Note> | undefined>('promise or undefined', second, [promise, optional, back, again]);
  console.log('direct: ' + (maybe === promise) + ' ' + (maybe === back) + ' ' + (fields.q === promise) + ' ' + (optional === promise) + ' ' + (fields.q === optional) + ' ' + (maybe === second));
  console.log('direct Object.is: ' + Object.is(maybe, promise) + ' ' + Object.is(maybe, back) + ' ' + Object.is(fields.q, promise) + ' ' + Object.is(promise, back) + ' ' + Object.is(optional, fields.q) + ' ' + Object.is(maybe, second));
  const nullable: Array<Promise<Note> | null> = [null, promise];
  console.log('direct searches: ' + nullable.indexOf(back) + ' ' + nullable.includes(back) + ' ' + nullable.lastIndexOf(back) + ' ' + nullable.indexOf(maybe) + ' ' + nullable.indexOf(fields.q) + ' ' + nullable.indexOf(second));
  const plain: Array<Promise<Note>> = [second, promise];
  console.log('direct searches, plain: ' + plain.indexOf(back) + ' ' + plain.includes(back) + ' ' + plain.lastIndexOf(back) + ' ' + plain.indexOf(again) + ' ' + plain.indexOf(back, 1) + ' ' + plain.includes(back, 1) + ' ' + plain.indexOf(Promise.resolve(record)));

  // Other places that ask whether two values are one promise.
  tried('assert.strictEqual', () => assert.strictEqual(boxed, boxedAgain));
  tried('assert.notStrictEqual', () => assert.notStrictEqual(boxed, boxedAgain));
  tried('assert.deepStrictEqual', () => assert.deepStrictEqual(boxed, boxedAgain));
  tried('assert.deepStrictEqual in arrays', () => assert.deepStrictEqual([boxed], [boxedAgain]));
  tried('assert.deepStrictEqual in records', () => assert.deepStrictEqual({p: boxed}, {p: boxedAgain}));
  tried('assert.deepEqual', () => assert.deepEqual(boxed, boxedAgain));
  tried('assert.notDeepStrictEqual', () => assert.notDeepStrictEqual(boxed, boxedAgain));
  function which(value: unknown): string {
    switch (value) {
      case second:
        return 'second';
      case promise:
        return 'promise';
      default:
        return 'neither';
    }
  }
  console.log('switch: ' + which(promise) + ' ' + which(back) + ' ' + which(boxed) + ' ' + which(second) + ' ' + which(record));
  console.log('Promise.resolve keeps a promise: ' + (Promise.resolve(promise) === promise) + ' ' + (Promise.resolve(back) === promise));
  const resolvedUntyped: unknown = Promise.resolve(boxed);
  console.log('Promise.resolve keeps an untyped promise: ' + (resolvedUntyped === boxed) + ' ' + (resolvedUntyped === boxedAgain));
  console.log('then makes another: ' + (promise.then(n => n) === promise) + ' ' + (promise.finally(() => {}) === promise) + ' ' + (promise.catch(() => record) === promise));
}

main();
