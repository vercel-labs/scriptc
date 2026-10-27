# @scriptc/experimental

Experimental scriptc APIs. Each export has a Node.js implementation, so programs that use them run unchanged under Node.js.

## LifetimeRegion

Instances of `ProgramLifetime` classes (`@scriptc/types`) are never freed in scriptc builds. A `LifetimeRegion` gives a long-running program a way to free a whole generation of them at once, for example the previous program of a compiler's watch mode.

```ts
import { LifetimeRegion } from "@scriptc/experimental";

let previous: LifetimeRegion | undefined;
function rebuild(): Program {
  const region = new LifetimeRegion();
  const program = region.run(() => buildProgram());
  previous?.release();
  previous = region;
  return program;
}
```

- `run(fn)` calls `fn` with the region as the current region and returns its result. `ProgramLifetime` instances created during the call belong to the region; calls nest.
- Instances created outside every `run` call belong to the default region, which is never freed.
- Async work started inside `fn` keeps its region: what it creates after an `await` belongs to the region too, and the region is not freed before that work has finished.
- `release()` requests that the region be freed. scriptc frees it once nothing outside the region refers to any of its instances; until then the region stays allocated. Later `run` calls on a released region allocate in the default region.
- A region that holds a published object (`@scriptc/threads`) is never freed.

Under Node.js, `run(fn)` returns `fn()` and `release()` does nothing.

In scriptc builds, `SCRIPTC_REGION_STATS=1` reports every release attempt on stderr.

## InternTable

An `InternTable` is a named, append-only table of published values (`@scriptc/threads`) that every thread of a scriptc program shares. Threads that build the same cache (interned types, strings, resolved modules) fill and read one table instead of one copy each.

```ts
import { InternTable } from "@scriptc/experimental";

class Type {
  readonly id: number;
  readonly members: readonly Type[];
  constructor(id: number, members: readonly Type[]) {
    this.id = id;
    this.members = members;
  }
}

// Module scope: every thread that evaluates this line opens the same table.
const unions = new InternTable<string, Type>("checker.unions");

function unionOf(members: readonly Type[]): Type {
  const key = members.map((m) => m.id).join(",");
  return unions.getOrInsertComputed(key, () => new Type(nextId(), members));
}
```

- `new InternTable<K, V>(name)` opens the table called `name`. Within one thread, every construction with the same name refers to the same table. In scriptc builds the table is shared by every thread of the process; under Node.js each thread has its own.
- Keys are strings, numbers, or arrays of numbers or of strings. Strings and numbers compare like `Map` keys: strings by content, numbers by SameValueZero. Arrays compare by their elements in the same way, so a freshly built `[a.id, b.id]` finds the value stored under an equal array; holes are equal to each other and to no number or string. An array key can have at most 65536 elements; longer ones make every method throw a `TypeError`.
- `get(key)`, `has(key)` and `size` read the table.
- `getOrInsert(key, value)` returns the value stored under `key`. When there is none, it publishes `value`, stores it and returns it.
- `getOrInsertComputed(key, callback)` returns the value stored under `key`. When there is none, it calls `callback(key)`, publishes the result and stores it, unless a value was stored under `key` meanwhile (by the callback, or in scriptc builds by another thread), and returns the stored value.
- A key's value never changes once stored, and there is no `set` or `delete`. Stored values and everything they reach are immutable; a value that `publish` refuses makes the call throw the same `TypeError` and stores nothing.
- No lock is held while a callback runs. Threads that miss one key at the same time may each call the callback; one result is stored and every call returns it.

scriptc requires the name to be a string literal, and every construction of one name in a program to use the same type arguments. Values must be numbers, booleans, strings, bigints, arrays, `Map`s, `Set`s, objects or class instances.

Programs that behave identically under scriptc and Node.js follow the `@scriptc/threads` rules and three more:

1. A stored value does not depend on which thread created it. In scriptc a value may come from another thread's callback.
2. Identity and ids are not compared across threads. Ids assigned inside callbacks are unique in both runtimes but differ between them.
3. A thread does not depend on another thread's inserts. `size` and `has` reflect every thread's inserts in scriptc and the calling thread's under Node.js.

Per-thread state about a shared value (lazily computed results, caches) belongs in thread-local state, for example a `ThreadSlots` family (below), a module-level `Map` keyed by the value, or an array indexed by an id the value carries: module state is per thread in both runtimes. In scriptc an array indexed by a dense id is the fastest of these.

In scriptc builds stored values are immortal: they stay allocated until the process exits, including values a callback computed for a key that another thread stored first.

## ThreadSlots

A `ThreadSlots` family holds one value per key and thread, like a `WeakMap` that each thread has its own copy of. A thread sees only the values it set, including for keys that every thread shares, such as values read from an `InternTable`, and setting a value never writes the key.

```ts
import { InternTable, ThreadSlots } from "@scriptc/experimental";

class Type {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class TypeState {
  resolved = false;
}

const types = new InternTable<number, Type>("checker.types");
// Module scope: every thread that evaluates this line opens the same family.
const states = new ThreadSlots<Type, TypeState>("checker.typeStates");

function stateOf(t: Type): TypeState {
  let state = states.get(t);
  if (state === undefined) {
    state = new TypeState();
    states.set(t, state);
  }
  return state;
}
```

- `new ThreadSlots<K, V>(name)` opens the family called `name`. Within one thread, every construction with the same name refers to the same family.
- `get(key)` and `has(key)` read the calling thread's value for `key`.
- `set(key, value)` sets the calling thread's value and returns the slots.
- `delete(key)` removes the calling thread's value and returns whether there was one.

scriptc requires the name to be a string literal, every construction of one name to use the same type arguments, the key type to be a class declared in the program (keys may be instances of its subclasses), and the value type to be a class, an object type, an array, a `Map` or a `Set`. The methods must be called through a module-level `const` initialized with `new ThreadSlots<K, V>("name")`, since a family's storage is found by its name when the program is compiled.

In scriptc builds every instance of a key class's hierarchy carries a 4-byte slot index, assigned by the first `set` for it and never reused. `get` reads the index, a page of the thread's family and the entry, with no lock, hash or atomic update. A family holds a reference to each of the thread's values and releases it when it is replaced or deleted, when its key is freed, and when the thread exits. Keys freed with a `LifetimeRegion` keep their values until the thread exits, a value that belongs to a region keeps the region allocated while the family holds it, and a value that refers to its own key keeps the key alive.

Under Node.js each family is a `WeakMap` per thread.
