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

## InlineArray

`InlineArray<T>` marks an array field of a `ProgramLifetime` class (`@scriptc/types`) whose elements scriptc keeps in the instance itself, after its other fields, instead of in an array object of their own. It suits a program with millions of short arrays that never change once built, such as the children of each node of a syntax tree.

```ts
import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";

class NodeList implements ProgramLifetime {
  readonly pos: number;
  readonly nodes: InlineArray<Node>;
  constructor(pos: number, nodes: readonly Node[]) {
    this.pos = pos;
    this.nodes = nodes;
  }
}

function visit(list: NodeList): void {
  const nodes = list.nodes;
  for (let i = 0; i < nodes.length; i++) visitNode(nodes[i]!);
}
```

- `T` is a `ProgramLifetime` class, and the field is an instance field of a `ProgramLifetime` class.
- The constructor of the class that declares the field writes it once, from one of its parameters. A subclass constructor passes one of its own parameters there through `super(...)`. Nothing else writes the field.
- Indexing the field, reading its `length` and iterating it with `for...of` read the elements from the instance, directly or through a `const` local used only in those ways. Any other use, such as passing the field to a function or calling one of its methods, gets an array of the elements, which is frozen in scriptc builds.
- The array passed to the constructor is one that nothing else keeps: a new array (a literal, a copy, or the result of a function that returns only such arrays or its own argument), a local array at its last use, a parameter whose callers each pass such an array, an array that an InlineArray field already holds, or a `const` array that is never written.
- The arrays fields hold are never written, through a read of the field (a cast) or through any other reference. scriptc follows them through locals, parameters, return values, fields, the elements of arrays, Maps and Sets, and closures, and reports one that reaches a write, a dynamic value (also inside the fields of an object that becomes one), a call through a function value (also inside an array, Map or Set passed there), or a library call other than printing and `JSON.stringify` without a replacer.
- Two reads of the field need not give the same array, so the arrays fields hold are never compared by identity: with `===` or `!==`, as an `indexOf` or `includes` argument, or as a Map key or Set element. Compare the elements instead, or keep a copy made with `slice()` where identity matters.
- Instances of the class are not constructed through a class value. They may become dynamic values, for example through a conversion to `unknown` or an interface several classes implement, when the dynamic code that sees them uses the class's own members and does not read the field: scriptc follows such values through locals, parameters, return values, fields, the elements of arrays, Maps and Sets, the members of dynamic objects and arrays, calls through function values, and the callbacks of array methods such as `map` and `forEach`, and finds the first that reaches a read or write of the field's name or of a computed key, a checked cast to a record, array or collection type that has a record member of the field's name or holds a dynamic value, a call through a value no compiled function reaches (also as an array method's callback), or a library call other than printing, `JSON.stringify` without a replacer, `publish`, a worker's `workerData`, and class tests and casts. A dynamic view of an inline field would read it as a new array each time, so when such an operation exists the field keeps its elements in an ordinary array, which behaves as under Node.js, and scriptc reports a warning (SC6105).

scriptc reports a field that does not keep these rules (SC7009). Under Node.js the field holds the array the constructor stored. In builds with sanitizers, in programs that use `LifetimeRegion`, and on platforms other than 64-bit Linux and macOS, the elements stay in an ordinary array object.

## Parallel loops

`parallelInto`, `parallelReduce` and `parallelFor` split a range of indices into chunks and call a function once per chunk. Under Node.js, and in a scriptc build whose chunks do not qualify for several threads, the calls run in chunk order on the calling thread.

```ts
import { parallelInto, parallelReduce } from "@scriptc/experimental";

const pixels = new Float64Array(width * height);
parallelInto(
  pixels,
  (part, start, end) => {
    for (let y = start; y < end; y++)
      for (let x = 0; x < width; x++) part[(y - start) * width + x] = shade(x, y);
  },
  { grain: 4 },
);

const total = parallelReduce(
  1_000_000,
  0,
  (start, end) => {
    let sum = 0;
    for (let i = start; i < end; i++) sum += weights[i]!;
    return sum;
  },
  (left, right) => left + right,
);
```

- `parallelInto(target, body, options?)` splits the indices `0 .. target.length / stride` into chunks `[start, min(start + grain, count))` and calls `body(part, start, end)` once per chunk, where `part` is `target.subarray(start * stride, end * stride)`. `options.stride` (default 1) is the distance between the indices the body works on, so a matrix row is one index of a flat array.
- `parallelReduce(count, initial, part, combine, options?)` computes one value per chunk and folds them from left to right in chunk order: `combine(...combine(combine(initial, part(c0)), part(c1))..., part(cn))`. `combine` need not be associative, and the result does not depend on how many threads ran the chunks. The value is a number.
- `parallelFor(count, body, options?)` calls `body(start, end)` once per chunk.
- `options.grain` is the number of indices in a chunk. The default is `Math.max(1, Math.ceil(count / 256))`, so a call makes about 256 chunks whatever the count. `grain` and `stride` must be positive integers, and `stride` must divide `target.length`; a call that breaks one of these throws a `RangeError` before any chunk runs, with the same message as under Node.js.

In scriptc builds the chunks of a `parallelInto` or a `parallelReduce` may run on several threads at once when scriptc can show that doing so is not observable:

- The callback is a function expression written at the call site.
- It reads numbers, booleans and the elements and `length` of typed arrays, and writes only elements of its `part` (`parallelInto`) and variables it declares itself, which hold numbers or booleans. `parallelReduce`'s `combine` reads only its arguments.
- It does not allocate, throw, `await`, or call anything except `Math`'s pure functions. A helper thread has no way to allocate or to carry a thrown value.

A captured typed array it reads is compared with the target: when the two overlap, the chunks run one after another, since one chunk's write could race another's read. A call that breaks a rule compiles to the sequential loop, which is exactly the Node.js call, and scriptc reports which rule it broke as a performance warning (SC6106), never as a build failure. `parallelFor` always runs its chunks one after another until scriptc can show that its callbacks write disjoint elements.

The number of threads is the process's, taken from `SCRIPTC_THREADS` (default: the hardware thread count, capped at 64). Results do not depend on it: chunks are handed out whole and the reduce fold is in chunk order, so a sum of floating-point values is the same on every run and every machine.

## Refusals

`@scriptc/experimental/refusals.json` lists the Node APIs and builtin modules that scriptc refuses, with the access a program uses to reach each one. The Node compatibility generator writes it beside the compatibility ledger, and `pnpm node-compat:check` fails when the committed table is stale. Each release publishes the table for its own compiler version.

```ts
import refusals from "@scriptc/experimental/refusals.json" with { type: "json" };

for (const refusal of refusals.refusals) {
  if (refusal.layer === "load") console.log(refusal.binding.module);
}
```

- The top level carries `schemaVersion`, the pinned `nodeVersion`, and the `compilerVersion` the table was generated for.
- `refusals` holds one entry per refusal site. `layer` is `"static"` for an API that scriptc refuses or `"load"` for a builtin module it does not serve.
- `binding` is the access that reaches the refusal: the `module` (spelled like an import, such as `node:crypto`), the member `path` inside it, and `access`, one of `"call"`, `"get"`, `"construct"`, `"listen"`, or `"import"`. A module import omits `path`, and a row the sources cannot place says `"unknown"` instead.
- A static entry names its `row` in the compatibility ledger, the compiler surface manifest entry in `manifestId`, and the row's `chapter`, `apiSymbol`, `kind`, and `label`.
- A load entry carries the `code` and `message` of its `SC1010` diagnostic, the same text `@scriptc/experimental/register` raises; for a module fenced by construction the message names the reason.

## Load hook

`@scriptc/experimental/register` is a preload that makes Node.js refuse a program the way a scriptc build does, before the program runs. Use it while developing so `node` and `scriptc` agree on what the program may load.

```console
node --require @scriptc/experimental/register app.ts
```

`--import` works the same way. Node.js 24 or newer is required.

The hook applies the refusals in `refusals.json`, the same data the compiler uses:

- Importing a builtin module that scriptc does not support fails with the compiler's code and message (`SC1010`).
- Loading a native addon (`.node`) fails with the compiler's code and message (`SC2020`).
- `process.getBuiltinModule` of an unsupported builtin throws the error a compiled program throws for that call.

A program can therefore run under Node.js with the hook, fail where the build fails, and give the same code and message. Running both in CI catches a refusal before a binary is built or deployed.

scriptc refuses code generation from strings, which Node.js does only with `--disallow-code-generation-from-strings`. The hook cannot set the flag for the process it joins, so add it to `NODE_OPTIONS`:

```console
NODE_OPTIONS=--disallow-code-generation-from-strings node --require @scriptc/experimental/register app.ts
```

The hook prints a warning to stderr when the flag is missing, or when the running Node.js version differs from the release the refusal data describes.
## Dual-run testing

`@scriptc/experimental/dual-run` runs a test file twice, once under Node.js and once as the executable scriptc builds, and compares the runs: test names, pass and fail results, assertion messages, program output and the exit code, with durations and stack frames normalized away. It is Node.js tooling, so a scriptc-built program cannot call it, and a compiled program never needs to.

```ts
import { dualRun } from "@scriptc/experimental/dual-run";

const result = await dualRun("test/format.test.ts");
if (!result.equal) throw new Error(result.diff);
```

`dualRun(entry, { args, stdin, env, cwd, timeoutMs })` returns `{ node, native, equal, diff }`, where each run has `stdout`, `stderr` and `exitCode`. A program that does not compile rejects with a `DualRunBuildError` whose `stderr` holds the diagnostics.

The `@scriptc/experimental/dual-run/reporter` subpath is a Node.js test reporter that does the same for every file `node --test` runs:

```console
$ node --test --test-reporter=@scriptc/experimental/dual-run/reporter --test-reporter-destination=stdout
```

It prints one line per file, shows a diff when the two runs differ, reports a file whose Node.js output itself varies as flaky, and fails the run on a difference. Both forms build through the `scriptc` command and its executable cache, found from `SCRIPTC_BIN`, `node_modules/.bin` or `PATH`. See [dual-run testing](https://scriptc.dev/docs/dual-run).
