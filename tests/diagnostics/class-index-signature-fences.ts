// A class index signature `[key: string]: any` (or `unknown`) compiles: a
// name the class does not declare is an own property of the instance
// (corpus 9361, 9362). What stays refused, by name:
// a signature whose value type has no `undefined` for an absent property,
class Labels {
  title = "t";
  [key: string]: string;
}
// a signature keyed by number,
class Slots {
  size = 0;
  [index: number]: unknown;
}
// and instance fields in a subclass of a class with a signature: Node
// creates them after the properties the base constructor added, and a
// compiled instance lists declared fields first.
class Open {
  id = 1;
  [key: string]: any;
  constructor() {
    this.added = true;
  }
}
class Closed extends Open {
  own = 2;
}
console.log(new Labels().title);
console.log(new Slots().size);
console.log(new Closed().own);

// Updates in place, deletes, calls and spreads through the signature have no
// lowering yet; each is refused where it is written.
const open = new Open();
open.hits = 1;
open.hits += 1;
open.hits++;
delete open.hits;
open.run = (): number => 1;
console.log(open.run());
console.log({ ...open });
