// `new Set(x)` / `new Map(x)` where x is declared Set/Map but read through a
// marked accessor view: the read lowers to a checked-dynamic value, so the
// native collection seeds from the dynamic iterator, converting each element
// (and each Map entry's key and value) through the checked conversion. Order,
// duplicates, reference identity, and independence from the source all match
// Node, which runs this same program byte-for-byte.

interface Item {
  id: string;
}

interface State {
  readonly label: string;
  readonly pending: Set<string>;
  readonly counts: Set<number>;
  readonly items: Set<Item>;
  readonly maybe: Set<string> | undefined;
  readonly present: Set<string> | undefined;
  readonly table: Map<string, number>;
  readonly named: Map<string, Item>;
  readonly maybeTable: Map<string, number> | undefined;
}
type Mutable = Omit<State, "label" | "pending"> & {
  label: string;
  pending: Set<string>;
};

const first: Item = { id: "a" };
const second: Item = { id: "b" };

function create(): Mutable {
  return {
    get label(): string {
      return "agent";
    },
    pending: new Set<string>(["a", "b", "a"]),
    counts: new Set<number>([3, 1, 3]),
    items: new Set<Item>([first, second]),
    maybe: undefined,
    present: new Set<string>(["p"]),
    table: new Map<string, number>([
      ["x", 1],
      ["y", 2],
      ["x", 9],
    ]),
    named: new Map<string, Item>([["a", first]]),
    maybeTable: undefined,
  };
}

class Owner {
  private m: Mutable = create();
  get state(): State {
    return this.m;
  }
  replace(): void {
    this.m.pending = new Set<string>(["q"]);
  }
}

const owner = new Owner();

// A copy keeps insertion order and collapses duplicates.
const copy = new Set(owner.state.pending);
console.log(copy.size, [...copy].join(","));

// The copy owns its storage: writes do not reach the source.
copy.add("c");
copy.delete("a");
console.log(copy.size, [...copy].join(","));
console.log(owner.state.pending.size, [...owner.state.pending].join(","));

// A non-string element type converts through the checked conversion.
console.log([...new Set(owner.state.counts)].join(","));

// Reference elements keep their identity.
const objectCopy = new Set(owner.state.items);
const copied = [...objectCopy][0]!;
console.log(copied === first, copied === second, [...objectCopy].map((item) => item.id).join(","));

// `dyn ?? fallback` selects the fallback exactly when the left is nullish.
console.log([...new Set(owner.state.maybe ?? ["f"])].join(","));
console.log([...new Set(owner.state.present ?? ["f"])].join(","));
console.log(new Set<string>(owner.state.maybe ?? undefined).size);

// Map copies keep insertion order and the last duplicate key's value.
const table = new Map(owner.state.table);
console.log(table.size, [...table].map(([k, v]) => k + "=" + v).join(","));
table.set("z", 3);
console.log(table.size, owner.state.table.size);

// Map values keep their identity too.
const named = new Map(owner.state.named);
console.log(named.get("a") === first);

// An empty dynamic source constructs empty storage.
console.log(new Map(owner.state.maybeTable).size);

owner.replace();
console.log(owner.state.pending.size, [...owner.state.pending].join(","));
console.log([...new Map(owner.state.named ?? [])].map(([k, v]) => k + ":" + v.id).join(","));
