// A class field holding records checked from a dynamic object: reading a
// record's fields runs its accessors, so a getter that empties the array the
// instance was built from must be seen by the walk instead of reading slots
// that the accessor replaced.
interface Item {
  id: number;
}

class Box {
  items: Item[];
  constructor(items: Item[]) {
    this.items = items;
  }
}

const source: any = [];
const raw = {
  get id() {
    source.length = 0;
    return 9;
  },
};
source.push(raw, { id: 2 }, { id: 3 });
const items = source as Item[];
console.log(JSON.stringify(new Box(items)));
