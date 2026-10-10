// Untyped code can write a field that the typed program only assigns in its
// constructor: the class instance keeps its identity behind `any`, and the
// write lands in the native field. Once a program contains such a store,
// every field reachable from a value that crosses into untyped code must be
// treated as writable, so reads of it keep owning their values while a
// callee replaces them.

class Item {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Holder {
  readonly item: Item;
  readonly label: string;
  constructor(item: Item, label: string) {
    this.item = item;
    this.label = label;
  }
}

function replace(target: any, value: any): void {
  target.item = value;
}

let shared = new Holder(new Item("before"), "h");

function useAfter(item: Item, drop: () => void): string {
  drop();
  const noise: Item[] = [];
  for (let i = 0; i < 64; i++) noise.push(new Item(`noise${i}`));
  return `${item.name} (${noise.length})`;
}

function viaAny(): string {
  const h = shared;
  const seen = useAfter(h.item, () => {
    replace(shared, new Item("after"));
  });
  return `${seen} -> ${h.item.name}`;
}

const box: { holder: Holder } = { holder: new Holder(new Item("boxed"), "b") };
function viaRecord(): string {
  const b = box;
  const seen = useAfter(b.holder.item, () => {
    (b.holder as unknown as { item: Item }).item = new Item("cast");
  });
  return `${seen} -> ${b.holder.item.name}`;
}

console.log(viaAny());
console.log(viaRecord());
let n = 0;
for (let i = 0; i < 500; i++) {
  shared = new Holder(new Item(`r${i}`), "loop");
  const h = shared;
  n += useAfter(h.item, () => replace(shared, new Item("x"))).length + h.item.name.length;
}
console.log(n);
