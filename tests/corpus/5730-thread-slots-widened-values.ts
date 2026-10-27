import { ThreadSlots } from "@scriptc/experimental";

// A ThreadSlots const annotated with a structurally wider value type than
// its constructor's: the values are stored with the constructor's layout and
// read back through the annotation's. Node.js prints the same.

class Key {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

interface Counted {
  count: number;
  label: string;
}

interface Labeled {
  label: string;
}

interface Tagged {
  label: string;
  tag?: string;
}

const counted: ThreadSlots<Key, Labeled> = new ThreadSlots<Key, Counted>("widened.counted");
const tagged: ThreadSlots<Key, Tagged> = new ThreadSlots<Key, Counted>("widened.tagged");

const first = new Key(1);
const second = new Key(2);
const value: Counted = { count: 7, label: "seven" };
counted.set(first, value);
const read = counted.get(first)!;
console.log(read.label, counted.get(second), counted.has(first));

tagged.set(second, { count: 2, label: "two" } as Counted);
const t = tagged.get(second);
console.log(t?.label, t?.tag, tagged.get(first));

function labelOf(slots: Labeled | undefined): string {
  return slots === undefined ? "none" : slots.label;
}
console.log(labelOf(counted.get(first)), labelOf(counted.get(second)));
