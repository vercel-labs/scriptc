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
