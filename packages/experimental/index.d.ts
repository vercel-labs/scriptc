/** An allocation context for ProgramLifetime instances (@scriptc/types).
 * In scriptc builds, instances created while `run` executes belong to the
 * region and are freed together once the region is released and nothing
 * outside it refers to them. Under Node.js, `run` calls its callback and
 * `release` does nothing. */
export declare class LifetimeRegion {
  constructor();
  /** Calls `fn` with this region as the current region and returns its
   * result. ProgramLifetime instances created during the call, outside
   * nested `run` calls of other regions, belong to this region, and so do
   * those that async functions called during it create after an `await`. */
  run<T>(fn: () => T): T;
  /** Requests that the region be freed. Its instances are freed once
   * nothing outside the region refers to any of them and the async work
   * started inside it has finished; until then the region stays allocated.
   * Later `run` calls allocate outside the region. Never observable except
   * through memory use. */
  release(): void;
}

/** A named, append-only table of published values (@scriptc/threads).
 * Every construction with one name opens the same table: in scriptc builds
 * all threads of the process share it, and under Node.js each thread has
 * its own. A key's value never changes once stored, and storing a value
 * publishes it, so stored values and everything they reach are immutable.
 * scriptc requires the name to be a string literal and every construction
 * of one name to use the same type arguments. */
export declare class InternTable<
  K extends string | number | readonly number[] | readonly string[],
  V,
> {
  /** Opens the table called `name`. */
  constructor(name: string);
  /** The number of entries. */
  readonly size: number;
  /** The value stored under `key`, or undefined. String and number keys
   * compare like Map keys: strings by content, numbers by SameValueZero.
   * Array keys compare by their elements in the same way; a hole and an
   * undefined element are equal. Every method throws a TypeError for an
   * array key of more than 65536 elements. */
  get(key: K): V | undefined;
  /** Whether `key` has a value. */
  has(key: K): boolean;
  /** Returns the value stored under `key`. When there is none, publishes
   * `value`, stores it and returns it. Throws publish's TypeError, storing
   * nothing, when `value` cannot be published. */
  getOrInsert(key: K, value: V): V;
  /** Returns the value stored under `key`. When there is none, calls
   * `callback(key)`, publishes its result and stores it, unless a value was
   * stored under `key` meanwhile (by the callback, or in scriptc builds by
   * another thread). Returns the stored value. No lock is held while the
   * callback runs: threads that miss one key at the same time may each
   * call it. */
  getOrInsertComputed(key: K, callback: (key: K) => V): V;
}

/** A named family of per-thread values keyed by objects, like a WeakMap
 * that each thread has its own copy of. Every construction with one name
 * opens the same family. A value set on one thread is visible only to that
 * thread, including for keys that every thread shares (published objects,
 * @scriptc/threads), and setting one never writes the key. scriptc requires
 * the name to be a string literal, every construction of one name to use
 * the same type arguments, the key type to be a class, and the slots to be
 * called through a module-level const initialized with `new ThreadSlots`. */
export declare class ThreadSlots<K extends object, V extends object> {
  /** Opens the family called `name`. */
  constructor(name: string);
  /** This thread's value for `key`, or undefined. */
  get(key: K): V | undefined;
  /** Whether this thread has a value for `key`. */
  has(key: K): boolean;
  /** Sets this thread's value for `key`. Returns the slots. */
  set(key: K, value: V): this;
  /** Removes this thread's value for `key`. Returns whether there was one. */
  delete(key: K): boolean;
}

/** An array field whose elements scriptc keeps in the instance itself
 * (@scriptc/types ProgramLifetime classes): `readonly f: InlineArray<C>`,
 * where C is a ProgramLifetime class. The class's constructor writes the
 * field once, from one of its parameters, and nothing else writes it.
 * The constructor is passed an array nothing else keeps, and the arrays
 * fields hold are never written. Reading the field gives an array of its
 * elements, frozen in scriptc builds; two reads need not give the same
 * array. Under Node.js it is the array the constructor stored. */
export type InlineArray<T> = readonly T[];

/** The typed arrays whose elements are numbers. */
export type NumberArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export interface ParallelOptions {
  /** How many indices one chunk covers: a positive integer. The default is
   * `Math.max(1, Math.ceil(count / 256))`. The chunks are a function of the
   * count and the grain only, so a program computes the same result on
   * every machine. */
  readonly grain?: number;
}

export interface ParallelIntoOptions extends ParallelOptions {
  /** How many elements of the target one index covers, for example the row
   * length of a matrix: a positive integer that divides `target.length`.
   * The default is 1. */
  readonly stride?: number;
}

/** Fills `target` chunk by chunk. The indices `0 .. target.length / stride`
 * are split into chunks `[start, end)`, and `body(part, start, end)` is
 * called once per chunk, in order, where `part` is
 * `target.subarray(start * stride, end * stride)`.
 *
 * In scriptc builds the calls run on several threads at once when the body
 * writes only to `part` and to values it creates, and does nothing that is
 * bound to one thread (see the package README). Otherwise they run one
 * after another as under Node.js, and scriptc reports why (SC6106). The
 * program's results are the same either way.
 *
 * The chunk boundaries depend on the count and the grain only, so a sum of
 * floating-point values computed over the chunks has one value on every
 * machine and under both runtimes. */
export declare function parallelInto<A extends NumberArray>(
  target: A,
  body: (part: A, start: number, end: number) => void,
  options?: ParallelIntoOptions,
): void;

/** Computes one value per chunk of the indices `0 .. count` and folds the
 * values from left to right in chunk order:
 * `combine(... combine(combine(initial, part(c0)), part(c1)) ..., part(cn))`.
 * `combine` need not be associative or commutative.
 *
 * In scriptc builds the `part` calls run on several threads at once when
 * `part` writes only to values it creates and `combine` reads and writes
 * only its arguments; the fold always runs on the calling thread. scriptc
 * compiles calls whose `initial` value and results are numbers. */
export declare function parallelReduce<T>(
  count: number,
  initial: T,
  part: (start: number, end: number) => T,
  combine: (left: T, right: T) => T,
  options?: ParallelOptions,
): T;

/** Calls `body(start, end)` once per chunk of the indices `0 .. count`, in
 * order. In scriptc builds the calls run on several threads at once when
 * scriptc can show that no call writes an element another call reads or
 * writes; scriptc builds run the chunks one after another until that proof
 * exists for the general form, which is the same result. */
export declare function parallelFor(
  count: number,
  body: (start: number, end: number) => void,
  options?: ParallelOptions,
): void;
