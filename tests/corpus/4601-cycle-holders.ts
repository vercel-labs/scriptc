// Objects that hold reference cycles without being able to lie on one need
// no cycle tracking: nothing reachable from the cycle can lead back to them,
// so their references are external counts and they die by reference
// counting alone, releasing the cycle to the collector. Types that reach a
// closure, which can capture anything, stay tracked. The sanitized lane's
// RC audit fails if any cycle below leaks.

class Ring {
  peer: Ring | null = null;
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function ring(value: number): Ring {
  const a = new Ring(value);
  const b = new Ring(value + 1);
  a.peer = b;
  b.peer = a;
  return a;
}

// Holds a cycle; no field of Ring can reach a Wrapper.
class Wrapper {
  readonly ring: Ring;
  readonly label: string;
  constructor(ring: Ring, label: string) {
    this.ring = ring;
    this.label = label;
  }
}

// Holds wrappers in a mutable array: still not on any cycle.
class Shelf {
  items: Wrapper[] = [];
  owner: Wrapper | null = null;
}

// Reaches a closure, which can capture the object itself.
class Callback {
  readonly ring: Ring;
  run: () => number;
  constructor(ring: Ring) {
    this.ring = ring;
    this.run = () => 0;
  }
}

interface Tagged {
  ring: Ring;
  tag: string;
}

let total = 0;
for (let round = 0; round < 300; round++) {
  const shelf = new Shelf();
  for (let i = 0; i < 20; i++) shelf.items.push(new Wrapper(ring(i), `w${i}`));
  shelf.owner = shelf.items[3]!;
  for (const w of shelf.items) total += w.ring.peer!.value;
  const cb = new Callback(ring(round));
  cb.run = () => cb.ring.value + total;
  total += cb.run() > 0 ? 1 : 0;
  const tagged: Tagged = { ring: ring(round), tag: "t" };
  total += tagged.ring.peer!.peer!.value;
  const kept: (Wrapper | Ring)[] = [shelf.owner, ring(1)];
  total += kept.length;
}
console.log(total);

// Release the last holder of a long-lived cycle late.
let late: Wrapper | null = new Wrapper(ring(1000), "late");
const peerValue = late.ring.peer!.value;
late = null;
console.log(peerValue, late === null);
