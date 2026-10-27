import { ThreadSlots } from "@scriptc/experimental";

// ThreadSlots (@scriptc/experimental): per-thread values keyed by class
// instances, like a WeakMap. Keys of a base class and its subclasses share
// one family; constructions with one name open the same family. Node.js
// prints the same.

class Node {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Leaf extends Node {
  readonly weight: number;
  constructor(name: string, weight: number) {
    super(name);
    this.weight = weight;
  }
}

class Info {
  count = 0;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
}

const info = new ThreadSlots<Node, Info>("basics.info");
const sameInfo = new ThreadSlots<Node, Info>("basics.info");
const other = new ThreadSlots<Node, Info>("basics.other");

function infoOf(n: Node): Info {
  let found = info.get(n);
  if (found === undefined) {
    found = new Info(`info of ${n.name}`);
    info.set(n, found);
  }
  found.count++;
  return found;
}

const a = new Node("a");
const b = new Leaf("b", 2);
console.log(info.get(a), info.has(a), info.delete(a));
console.log(infoOf(a).label, infoOf(a).count, infoOf(b).label, infoOf(b).count);
console.log(info.has(a), info.has(b), sameInfo.get(a)?.count, other.has(a));

// set returns the slots, so calls chain.
const c = new Leaf("c", 3);
const chained = other.set(a, new Info("other a")).set(c, new Info("other c"));
console.log(chained === other, other.get(a)?.label, other.get(c)?.label, other.has(b));

// Replacing and deleting.
other.set(a, new Info("other a again"));
console.log(other.get(a)?.label, other.delete(a), other.delete(a), other.get(a));
console.log(sameInfo.delete(b), info.has(b), info.get(b));

// Many keys: values come back for each, after keys around them go away.
const kept: Node[] = [];
for (let i = 0; i < 5000; i++) {
  const n = i % 2 === 0 ? new Node(`n${i}`) : new Leaf(`l${i}`, i);
  info.set(n, new Info(`#${i}`));
  if (i % 3 === 0) kept.push(n);
}
let sum = 0;
for (const n of kept) sum += Number(info.get(n)!.label.slice(1));
console.log(kept.length, sum, info.get(kept[kept.length - 1]!)?.label);

// A key whose value refers back to the key.
class Holder {
  readonly node: Node;
  constructor(node: Node) {
    this.node = node;
  }
}
const backs = new ThreadSlots<Node, Holder>("basics.back");
for (let i = 0; i < 100; i++) {
  const n = new Node(`back${i}`);
  backs.set(n, new Holder(n));
  if (i === 99) console.log(backs.get(n)?.node === n, backs.get(n)?.node.name);
}
console.log(typeof info);
