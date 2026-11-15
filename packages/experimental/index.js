// @scriptc/experimental — the Node.js implementation.
//
// scriptc builds lower these exports to compiler intrinsics. Under Node.js
// a LifetimeRegion is an ordinary object: run() calls its callback and
// release() does nothing, since the garbage collector reclaims what the
// program no longer references. An InternTable is a Map per name and
// thread: Node.js threads share no objects, so every thread has its own
// tables, and stored values are published (deep-frozen) as in scriptc.
// ThreadSlots is a WeakMap per name and thread: module state is per thread
// under Node.js, so each thread sees only the values it set. InlineArray is
// a type (`import type`), with no value here: under Node.js the field holds
// the array its constructor stored. The parallel loops are the loops the
// scriptc build compiles: every chunk runs on the calling thread, in chunk
// order, so a program prints the same either way.

import { publish } from "@scriptc/threads";

export class LifetimeRegion {
  /** Calls `fn` and returns its result. */
  run(fn) {
    return fn();
  }

  /** Does nothing under Node.js. */
  release() {}
}

/** This thread's tables, by name. */
const tables = new Map();

/** The Map key of a table key: strings and numbers as they are, arrays as a
 * string that encodes each element (numbers by SameValueZero, strings by
 * content, holes and undefined elements alike). Arrays of more than 65536
 * elements are refused, as in scriptc builds. */
function keyOf(key) {
  if (!Array.isArray(key)) return key;
  if (key.length > 65536)
    throw new TypeError("InternTable array keys can have at most 65536 elements");
  let text = "";
  for (let i = 0; i < key.length; i++) {
    const element = key[i];
    if (typeof element === "number") text += `n${Object.is(element, -0) ? 0 : element};`;
    else if (typeof element === "string") text += `s${element.length}:${element}`;
    else text += "u;";
  }
  return text;
}

export class InternTable {
  #entries;

  /** Opens the table called `name`. */
  constructor(name) {
    if (typeof name !== "string") throw new TypeError("The table name must be a string");
    let entries = tables.get(name);
    if (entries === undefined) tables.set(name, (entries = new Map()));
    this.#entries = entries;
  }

  /** The number of entries. */
  get size() {
    return this.#entries.size;
  }

  /** The value stored under `key`, or undefined. */
  get(key) {
    return this.#entries.get(keyOf(key));
  }

  /** Whether `key` has a value. */
  has(key) {
    return this.#entries.has(keyOf(key));
  }

  /** The value stored under `key`; when there is none, publishes `value`,
   * stores it and returns it. */
  getOrInsert(key, value) {
    const entries = this.#entries;
    const k = keyOf(key);
    if (entries.has(k)) return entries.get(k);
    publish(value);
    entries.set(k, value);
    return value;
  }

  /** The value stored under `key`; when there is none, publishes
   * `callback(key)` and stores it, unless the callback stored a value under
   * `key` itself. Returns the stored value. */
  getOrInsertComputed(key, callback) {
    const entries = this.#entries;
    const k = keyOf(key);
    if (entries.has(k)) return entries.get(k);
    const value = publish(callback(key));
    if (entries.has(k)) return entries.get(k);
    entries.set(k, value);
    return value;
  }
}

/** This thread's slot families, by name. */
const families = new Map();

/** The chunk count check of the parallel functions: `count` must be a
 * non-negative integer, as a typed array's length always is. */
function checkedCount(count) {
  if (!Number.isInteger(count) || count < 0)
    throw new RangeError("count must be a non-negative integer");
  return count;
}

/** One chunk's indices per call: the option when given, else about 256
 * chunks over `count` indices. */
function grainOf(count, options) {
  const grain = options?.grain ?? Math.max(1, Math.ceil(count / 256));
  if (!Number.isInteger(grain) || grain < 1)
    throw new RangeError("grain must be a positive integer");
  return grain;
}

/** Fills `target` chunk by chunk, in order, on the calling thread: the
 * meaning of every scriptc build of the call. */
export function parallelInto(target, body, options) {
  const stride = options?.stride ?? 1;
  if (!Number.isInteger(stride) || stride < 1 || target.length % stride !== 0)
    throw new RangeError("stride must be a positive integer that divides the target's length");
  const count = target.length / stride;
  const grain = grainOf(count, options);
  for (let start = 0; start < count; start += grain) {
    const end = Math.min(start + grain, count);
    body(target.subarray(start * stride, end * stride), start, end);
  }
}

/** Folds one value per chunk of [0, count) from left to right, in chunk
 * order, on the calling thread. */
export function parallelReduce(count, initial, part, combine, options) {
  checkedCount(count);
  const grain = grainOf(count, options);
  let result = initial;
  for (let start = 0; start < count; start += grain) {
    result = combine(result, part(start, Math.min(start + grain, count)));
  }
  return result;
}

/** Calls `body` once per chunk of [0, count), in order, on the calling
 * thread. */
export function parallelFor(count, body, options) {
  checkedCount(count);
  const grain = grainOf(count, options);
  for (let start = 0; start < count; start += grain) body(start, Math.min(start + grain, count));
}

export class ThreadSlots {
  #values;

  /** Opens the family called `name`. */
  constructor(name) {
    if (typeof name !== "string") throw new TypeError("The slots name must be a string");
    let values = families.get(name);
    if (values === undefined) families.set(name, (values = new WeakMap()));
    this.#values = values;
  }

  /** This thread's value for `key`, or undefined. */
  get(key) {
    return this.#values.get(key);
  }

  /** Whether this thread has a value for `key`. */
  has(key) {
    return this.#values.has(key);
  }

  /** Sets this thread's value for `key`. Returns the slots. */
  set(key, value) {
    this.#values.set(key, value);
    return this;
  }

  /** Removes this thread's value for `key`. Returns whether there was one. */
  delete(key) {
    return this.#values.delete(key);
  }
}
