// A class field holding an array with a record-view element: the view keeps
// its values behind an indirection, so the writer must read it as a view
// rather than copying its (empty) slot words.
interface Item {
  name: string;
}

class Box {
  items: Item[];
  constructor(items: Item[]) {
    this.items = items;
  }
}

const items: Item[] = [{ name: "a" }, {} as Item];
console.log(JSON.stringify(new Box(items)));
