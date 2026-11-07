// @requires-libnode
// The ways a class instance reaches an island without an expression that
// is statically its class: a parameter typed by the island's interface, a
// member of a record, an array or a Map, `unknown`, the result of a
// program callback, a value the island kept. Each used to arrive without
// its prototype methods ("sink.take is not a function", or silently
// `typeof sink.take === "undefined"`), unless the class had crossed
// directly earlier in the run.
//
// The methods are those of the class the object was constructed as, not
// of the static type it crossed under: a subclass instance held as its
// base class used to run the base class's method in the island (7 where
// Node prints 14) and lacked the methods only the subclass declares.
import {
  callBack,
  extra,
  keep,
  kinds,
  sameTake,
  shape,
  useHolder,
  useKept,
  useList,
  useNest,
  useSink,
  useTable,
  type Holder,
  type Nest,
  type Sink,
} from "paths-pkg";

class Counter implements Sink {
  name = "counter";
  sum = 0;
  take(n: number): number {
    this.sum += n;
    return this.sum;
  }
}
class Doubling extends Counter {
  override take(n: number): number {
    return super.take(n * 2);
  }
  extra(): string {
    return "extra:" + this.sum;
  }
}
abstract class Scaled implements Sink {
  name = "scaled";
  abstract scale(): number;
  take(n: number): number {
    return n * this.scale();
  }
}
class Tripling extends Scaled {
  scale(): number {
    return 3;
  }
}
class Outer implements Nest {
  inner: Counter = new Doubling();
}

function line(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", (e as Error).message);
  }
}

// 1. Typed by the island's interface, by `unknown`, and nested in values
// that cross by reference.
function pass(sink: Sink): number {
  return useSink(sink);
}
line("parameter", () => pass(new Counter()));
line("unknown", () => {
  const value: unknown = new Counter();
  return shape(value);
});
line("record literal", () => {
  const sink: Sink = new Counter();
  return useHolder({ sink, label: "abc" });
});
line("record binding", () => {
  const holder: Holder = { sink: new Counter(), label: "abcd" };
  return useHolder(holder);
});
line("array", () => {
  const list: Sink[] = [new Counter(), new Doubling()];
  return useList(list);
});
line("map", () => {
  const table = new Map<string, Sink>();
  table.set("k", new Counter());
  return useTable(table);
});
line("class field", () => useNest(new Outer()));

// 2. Out of a program callback the island calls, and kept by the island
// across calls.
line("callback", () => callBack(() => new Counter()));
line("callback binding", () => {
  const sink: Sink = new Doubling();
  return callBack(() => sink);
});
line("kept", () => {
  const sink: Sink = new Counter();
  keep(sink);
  return useKept();
});

// 3. The object's own class decides: a subclass instance under its base
// class's type, under the island's type, and under an abstract base.
line("subclass as base", () => {
  const base: Counter = new Doubling();
  return useSink(base);
});
line("subclass as base, extra", () => {
  const base: Counter = new Doubling();
  return extra(base);
});
line("subclass as island type", () => {
  const sink: Sink = new Doubling();
  return extra(sink) + " " + useSink(sink);
});
line("subclass as itself", () => extra(new Doubling()));
line("abstract base", () => {
  const scaled: Scaled = new Tripling();
  return useSink(scaled);
});

// 4. One object, two static types: whichever crosses first, the island
// sees the same object with the same methods.
line("base first", () => {
  const doubling = new Doubling();
  const base: Counter = doubling;
  return extra(base) + " " + extra(doubling) + " " + useSink(base) + " " + useSink(doubling);
});
line("derived first", () => {
  const doubling = new Doubling();
  const base: Counter = doubling;
  return extra(doubling) + " " + extra(base) + " " + useSink(doubling) + " " + useSink(base);
});

// 5. A method is one function for every instance of its class.
line("identity", () => {
  const a: Sink = new Counter();
  const b: Sink = new Counter();
  return sameTake(a, b);
});

// 6. The kinds of member an island can name: methods (async, with a
// callback, an optional parameter, overloads) and an accessor; not statics
// or #private methods.
class Kinds {
  n = 1;
  #secret = 9;
  plain(): number {
    return this.n;
  }
  async later(k: number): Promise<number> {
    return this.n + k;
  }
  each(f: (n: number) => number): number {
    return f(this.n);
  }
  opt(k?: number): number {
    return k === undefined ? -1 : k;
  }
  over(x: number): string;
  over(x: string): string;
  over(x: number | string): string {
    return typeof x + ":" + x;
  }
  static stat(): number {
    return 1;
  }
  #hidden(): number {
    return this.#secret;
  }
  get value(): number {
    return this.#hidden();
  }
}
const untyped: unknown = new Kinds();
console.log(await kinds(untyped));
console.log(await kinds(new Kinds()), Kinds.stat());
