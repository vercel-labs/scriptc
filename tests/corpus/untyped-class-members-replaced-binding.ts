// Members of an untyped binding the checker types as a class, where a class
// test alone does not say what the binding holds when a member is read: a
// warehouse slot whose crate is replaced or dropped while a call on it is
// being evaluated (by an argument, by an accessor), and bindings that reach
// the class type without `instanceof`: the loop variable of a generator, a
// type predicate, a predicate that accepts any object with a weight, and an
// assertion function. Every read and call must answer as Node does for the
// value the binding holds at that moment.
let slot: unknown = null;

class Crate {
  label: string;
  weight: number;
  next: Crate | null = null;
  constructor(label: string, weight: number) {
    this.label = label;
    this.weight = weight;
  }
  add(a: number, b: number): number {
    return this.weight + a + b;
  }
  describe(suffix: string): string {
    return this.label + suffix + String(this.weight);
  }
  get poke(): number {
    slot = null;
    return this.weight;
  }
  get retall(): number {
    slot = new Tall("retall", 40);
    return this.weight;
  }
}
class Tall extends Crate {
  height = 9;
  add(a: number, b: number): number {
    return this.weight * 100 + a + b + this.height;
  }
}

function swapToPlain(): number {
  slot = { label: "plain", weight: 1000, add: (a: number, b: number): number => a - b };
  return 1;
}
function swapToNull(): number {
  slot = null;
  return 2;
}
function swapToTall(): number {
  slot = new Tall("tall", 5);
  return 3;
}
function linked(): Crate {
  const head = new Crate("h", 8);
  head.next = new Crate("i", 9);
  return head;
}
function show(what: string, f: () => unknown): void {
  try {
    console.log(what + ": " + String(f()));
  } catch (e) {
    console.log(what + ": threw " + (e instanceof Error ? e.name + ": " + e.message : String(e)));
  }
}

// The receiver is read before the arguments: the call runs on the crate the
// slot held, and a later read sees what the slot holds then.
show("call, argument swaps to a plain object", () => {
  slot = new Crate("a", 1);
  if (slot instanceof Crate) return slot.add(swapToPlain(), 10);
  return "not a crate";
});
show("call, argument swaps to a plain object, then reads again", () => {
  slot = new Crate("a", 1);
  if (slot instanceof Crate) return slot.add(swapToPlain(), slot.weight);
  return "not a crate";
});
show("call, argument drops the value", () => {
  slot = new Crate("b", 2);
  if (slot instanceof Crate) return slot.add(swapToNull(), 1);
  return "not a crate";
});
show("call, argument drops the value, the method reads its fields", () => {
  slot = new Crate("c", 3);
  if (slot instanceof Crate) return slot.describe("#" + String(swapToNull()));
  return "not a crate";
});
show("call, argument swaps to a subclass, then reads again", () => {
  slot = new Crate("d", 1);
  if (slot instanceof Crate) return slot.add(swapToTall(), slot.weight);
  return "not a crate";
});
show("read after the value was dropped", () => {
  slot = new Crate("e", 4);
  if (slot instanceof Crate) return String(swapToNull()) + String(slot.weight);
  return "not a crate";
});
show("accessor drops the value", () => {
  slot = new Crate("f", 6);
  if (slot instanceof Crate) return slot.poke * 2;
  return "not a crate";
});
show("accessor drops the value, then a read", () => {
  slot = new Crate("f", 6);
  if (slot instanceof Crate) return slot.poke + slot.weight;
  return "not a crate";
});
show("accessor swaps to a subclass, then a call", () => {
  slot = new Crate("g", 7);
  if (slot instanceof Crate) return slot.retall + slot.add(1, 2);
  return "not a crate";
});
show("chain through a field, argument drops the value", () => {
  slot = linked();
  if (slot instanceof Crate) return slot.next!.add(swapToNull(), 1);
  return "not a crate";
});
show("optional link, argument drops the value", () => {
  slot = linked();
  if (slot instanceof Crate) return slot.next?.describe("~" + String(swapToNull()));
  return "not a crate";
});
show("a subclass in the slot, argument swaps to a plain object", () => {
  slot = new Tall("t", 3);
  if (slot instanceof Tall) return slot.add(swapToPlain(), slot.weight);
  return "not tall";
});

function localSwap(): unknown {
  let v: unknown = new Crate("l", 2);
  const swap = (): number => {
    v = { weight: 50 };
    return 1;
  };
  if (v instanceof Crate) return v.add(swap(), v.weight);
  return "not a crate";
}
function localDrop(): unknown {
  let v: unknown = linked();
  const drop = (): number => {
    v = null;
    return 1;
  };
  if (v instanceof Crate) return v.next!.describe("!" + String(drop()));
  return "not a crate";
}
show("captured local, argument swaps it, then reads again", localSwap);
show("captured local, argument drops it", localDrop);

// The loop variable of a generator.
function* crates(): Generator<Crate> {
  yield new Crate("g1", 1);
  yield new Tall("g2", 2);
  yield linked();
}
let total = 0;
for (const c of crates()) total += c.weight + c.add(1, 2) + (c.next?.weight ?? 0);
console.log("generator at the top level: " + String(total));
function sum(): string {
  let t = 0;
  let names = "";
  for (const c of crates()) {
    t += c.weight + c.add(1, 2);
    names += c.describe("=") + " ";
  }
  return names + String(t);
}
console.log("generator in a function: " + sum());

// Other ways to the class type. The loose predicate and the assertion accept
// objects that are not crates; their members answer by name.
function isCrate(v: unknown): v is Crate {
  return v instanceof Crate;
}
function looksLikeCrate(v: unknown): v is Crate {
  return typeof v === "object" && v !== null && "weight" in v;
}
function assertCrate(v: unknown): asserts v is Crate {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
}
function viaPredicate(v: unknown): unknown {
  if (isCrate(v)) return v.weight + v.add(1, 1);
  return "no";
}
function viaLoosePredicate(v: unknown): unknown {
  if (looksLikeCrate(v)) return String(v.weight) + "/" + String(v.add(2, 1));
  return "no";
}
function viaLooseRead(v: unknown): unknown {
  if (looksLikeCrate(v)) return String(v.weight) + "/" + String(v.label) + "/" + String(v.next);
  return "no";
}
function viaAssertion(v: unknown): unknown {
  assertCrate(v);
  return v.weight;
}
const values: unknown[] = [
  new Crate("p", 11),
  new Tall("q", 12),
  linked(),
  { label: "plain", weight: 1000, add: (a: number, b: number): number => a - b },
  { label: "bare", weight: 3, next: null },
  null,
  "text",
  5,
];
for (let i = 0; i < values.length; i++) {
  const v = values[i];
  show("predicate " + String(i), () => viaPredicate(v));
  show("loose predicate, call " + String(i), () => viaLoosePredicate(v));
  show("loose predicate, reads " + String(i), () => viaLooseRead(v));
  show("assertion " + String(i), () => viaAssertion(v));
}
