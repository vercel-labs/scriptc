// @requires-libnode
// Objects a Node island made as keys of native weak collections. The key is
// the island's object, not the handle the program holds: the same object
// is the same key however it reaches native code, an entry stays while
// only the island keeps its key, and V8 decides which values are keys.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function attempt(label: string, body: () => unknown): void {
  try {
    console.log(label, body());
  } catch (error) {
    console.log(label, "threw:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

const map = new WeakMap<object, unknown>();
const set = new WeakSet<object>();

// The program's handles end with this call; the island keeps the object.
function enterAndDrop(): void {
  const key: object = lib.keep("stays");
  map.set(key, "kept by the island");
  set.add(key);
}

function main(): void {
  // A key read back through a second crossing of the same object.
  const first: object = lib.make("first");
  attempt("second crossing", () => {
    map.set(first, 1);
    const again: object = lib.last();
    return [map.get(again), map.has(again), again === first].join(" ");
  });

  // A key reached through a property of another island object.
  const holder = lib.holder("h");
  attempt("through a property", () => {
    map.set(holder.child, "child");
    return [map.get(lib.childOf(holder)), map.has(holder.child), map.has(holder)].join(" ");
  });

  // One island object held by two native bindings.
  const one: object = lib.make("one");
  const other: object = lib.same(one);
  attempt("two bindings", () => {
    map.set(one, "one");
    const seen = map.get(other);
    const deleted = map.delete(other);
    return [seen, deleted, map.has(one), map.delete(one), map.get(one)].join(" ");
  });

  attempt("weak set", () => {
    set.add(first);
    set.add(first);
    const fresh: object = lib.make("fresh");
    return [set.has(lib.same(first)), set.has(fresh), set.delete(first), set.has(first), set.delete(first)].join(" ");
  });

  // Values: native ones keep their identity, island ones theirs.
  attempt("values", () => {
    const native = { n: 1 };
    const list = [1, 2];
    const answer = (): string => "called";
    const described: object = lib.describe(first);
    const keys: object[] = [];
    for (let i = 0; i < 9; i++) keys.push(lib.make("k" + i));
    map.set(keys[0]!, native);
    map.set(keys[1]!, described);
    map.set(keys[2]!, undefined);
    map.set(keys[3]!, "text");
    map.set(keys[4]!, list);
    map.set(keys[5]!, answer);
    map.set(keys[6]!, null);
    map.set(keys[7]!, 10n);
    map.set(keys[8]!, -0);
    list.push(3);
    native.n = 2;
    return [
      map.get(keys[0]!) === native,
      map.get(keys[1]!) === described,
      map.get(keys[2]!),
      map.has(keys[2]!),
      map.get(keys[3]!),
      map.get(keys[4]!) === list,
      (map.get(keys[5]!) as () => string)(),
      map.get(keys[6]!),
      map.get(keys[7]!),
      Object.is(map.get(keys[8]!), -0),
      map.get({}),
    ].join(" ");
  });
  attempt("replaced value", () => {
    const key: object = lib.make("replaced");
    map.set(key, { v: 1 });
    map.set(key, "second");
    map.set(lib.same(key), lib.describe(key));
    return lib.nameOf(key) + " " + typeof map.get(key);
  });
  attempt("an island value that reaches its key", () => {
    const key: object = lib.make("owned");
    const owner: object = lib.owner(key);
    map.set(key, owner);
    return map.get(lib.same(key)) === owner;
  });
  attempt("seeded", () => {
    const key: object = lib.make("seed");
    const seeded = new WeakMap<object, number>([[key, 7]]);
    const seededSet = new WeakSet<object>([key]);
    return [seeded.get(lib.last()), seededSet.has(lib.last()), seeded.has(first)].join(" ");
  });

  // Native and island keys share one collection.
  attempt("mixed keys", () => {
    const native = { native: true };
    const island: object = lib.make("mixed");
    const mixed = new WeakMap<object, string>();
    mixed.set(native, "native");
    mixed.set(island, "island");
    return [mixed.get(native), mixed.get(lib.same(island)), mixed.delete(native), mixed.has(island)].join(" ");
  });

  // Functions and symbols an island made.
  attempt("island function", () => {
    const f: object = lib.fn("f");
    map.set(f, "fn");
    return [map.get(lib.kept("fn:f")), map.has(lib.fn("g"))].join(" ");
  });
  attempt("island function through a typed view", () => {
    const named: () => string = lib.fn("typed");
    const functions = new WeakMap<() => string, string>();
    functions.set(named, named());
    const again: () => string = lib.kept("fn:typed");
    const other: () => string = lib.fn("other");
    return [functions.get(again), functions.has(other), again === named, functions.delete(again), functions.has(named)].join(" ");
  });
  attempt("island symbol", () => {
    const s = lib.symbol("s");
    const symbols = new WeakSet<any>();
    symbols.add(s);
    return [symbols.has(s), symbols.has(lib.symbol("s"))].join(" ");
  });
  attempt("registered symbol in a set", () => {
    const symbols = new WeakSet<any>();
    symbols.add(lib.registered("r"));
    return "added";
  });
  attempt("registered symbol in a map", () => {
    const symbols = new WeakMap<any, number>();
    const r = lib.registered("r");
    const before = [symbols.has(r), symbols.get(r), symbols.delete(r)].join(" ");
    symbols.set(r, 1);
    return before;
  });

  // The refusal is a TypeError the program can catch as one.
  try {
    new WeakSet<any>().add(lib.registered("r"));
  } catch (error) {
    const thrown: any = error;
    console.log("refused by", error instanceof TypeError, thrown.constructor.name, thrown.message);
  }

  // A key the program dropped while the island keeps it: the entry is
  // there when the object comes back.
  enterAndDrop();
  attempt("dropped natively, kept by the island", () => {
    const back: object = lib.kept("stays");
    return [map.get(back), set.has(back), map.delete(back), map.has(lib.kept("stays"))].join(" ");
  });
  // And the island forgets an object the program still holds.
  const mine: object = lib.keep("mine");
  map.set(mine, "native keeps the key");
  lib.forget("mine");
  attempt("forgotten by the island, kept natively", () => [map.get(mine), lib.kept("mine"), lib.same(mine) === mine].join(" "));

  // FinalizationRegistry: targets, held values and tokens.
  attempt("registry", () => {
    const registry = new FinalizationRegistry<unknown>(() => {});
    const target: object = lib.make("target");
    const token: object = lib.make("token");
    registry.register(target, "held", token);
    registry.register(lib.make("second"), lib.make("held object"), token);
    registry.register(lib.make("third"), 1);
    registry.register({ native: true }, lib.make("held by a native target"), lib.same(token));
    return [registry.unregister(lib.same(token)), registry.unregister(token), registry.unregister(target)].join(" ");
  });
  attempt("registry, target is the held value", () => {
    const registry = new FinalizationRegistry<unknown>(() => {});
    const target: object = lib.make("target");
    registry.register(target, lib.same(target));
    return "registered";
  });
}

main();
