// Reflecting a class's prototype through an untyped value builds the
// prototype view of every class the program can box, which lowers each
// member a second time over a dynamic receiver. A member whose body reads a
// typed field where the checker requires that field's own type (a Map key
// here) cannot run over that receiver: the statement stays a run-time fence,
// and the view still answers the descriptors Node reports.
class Item {
  name = "it";
}

const seen: Map<Item, number> = new Map();

class Timer {
  readonly item: Item;
  constructor(item: Item) {
    this.item = item;
  }
  get currentTime(): number {
    return 0;
  }
  set currentTime(ms: number) {
    const state = seen.get(this.item);
    console.log("time", state === undefined ? -1 : state, ms);
  }
}

function descriptorOf(o: any) {
  return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(o), "currentTime");
}

const timer = new Timer(new Item());
const descriptor = descriptorOf(timer)!;
console.log(descriptor !== undefined, typeof descriptor.get, typeof descriptor.set);
console.log(descriptor.get!.call(timer));
timer.currentTime = 5;
seen.set(timer.item, 7);
timer.currentTime = 9;
