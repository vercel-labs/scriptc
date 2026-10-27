// Acyclic contract types (@scriptc/types): scriptc proves these classes and
// object types cannot lie on a reference cycle, so their objects carry no
// cycle-collector header and are freed by reference counting alone.
import type { Acyclic, Int32 } from "@scriptc/types";
import type * as sc from "@scriptc/types";

class Cons implements Acyclic {
  readonly head: number;
  readonly tail: Cons | undefined;
  constructor(head: number, tail: Cons | undefined) {
    this.head = head;
    this.tail = tail;
  }
}

class Tree implements Acyclic {
  readonly left: Tree | null;
  readonly right: Tree | null;
  readonly value: number;
  constructor(left: Tree | null, right: Tree | null, value: number) {
    this.left = left;
    this.right = right;
    this.value = value;
  }
  sum(): number {
    return this.value + (this.left === null ? 0 : this.left.sum()) + (this.right === null ? 0 : this.right.sum());
  }
}

// Mutable scalar fields do not matter: only references can form cycles.
class Counter implements sc.Acyclic {
  count = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

// `implements Acyclic` names an interface only @scriptc/types declares, so
// other object types (here a Record) keep their layouts, and the Int32
// field of a class stored in one stays checkable.
class Slot implements Acyclic {
  index: Int32 = 0;
}

interface Point extends Acyclic {
  readonly x: number;
  readonly y: number;
}

type Segment = Acyclic<{ readonly from: Point; readonly to: Point; readonly label: string }>;

// A generic class is acyclic like any other class.
class Chain<T> implements Acyclic {
  readonly value: T;
  readonly next: Chain<T> | undefined;
  constructor(value: T, next: Chain<T> | undefined) {
    this.value = value;
    this.next = next;
  }
}

function build(depth: number): Tree {
  return depth === 0 ? new Tree(null, null, 1) : new Tree(build(depth - 1), build(depth - 1), depth);
}

let list: Cons | undefined = undefined;
for (let i = 0; i < 100000; i++) list = new Cons(i, list);
let total = 0;
for (let c = list; c !== undefined; c = c.tail) total += c.head;
console.log(total);
console.log(build(16).sum());

const counter = new Counter("ticks");
for (let i = 0; i < 10; i++) counter.count++;
counter.label = `${counter.label}!`;
console.log(counter.label, counter.count);

const segments: Segment[] = [];
for (let i = 0; i < 5; i++) segments.push({ from: { x: i, y: 0 }, to: { x: i, y: i * i }, label: `s${i}` });
console.log(segments.map((s) => `${s.label}:${s.to.y - s.from.y}`).join(" "));

const slots: Record<string, Slot> = { a: new Slot() };
for (let i = 0; i < 3; i++) slots["a"]!.index = (slots["a"]!.index + 2) | 0;
slots["b"] = new Slot();
console.log(Object.keys(slots).join(","), slots["a"]!.index, slots["b"]!.index);

let numbers: Chain<number> | undefined = undefined;
let words: Chain<string> | undefined = undefined;
for (let i = 0; i < 1000; i++) {
  numbers = new Chain(i, numbers);
  words = new Chain(`w${i % 7}`, words);
}
let chained = 0;
for (let c = numbers; c !== undefined; c = c.next) chained += c.value;
let longest = "";
for (let c = words; c !== undefined; c = c.next) if (c.value > longest) longest = c.value;
console.log(chained, longest);
