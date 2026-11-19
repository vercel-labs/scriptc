// A JavaScript set accessor whose parameter has no annotation stores whatever
// the caller passes, including an instance that lacks the properties the
// getter's inferred type names. Node stores it; the getter answers it.

class Box {
  constructor() {
    this._item = null;
  }
  /** @returns {Item} */
  get item() {
    return this._item;
  }
  set item(next) {
    this._item = next;
  }
}

class Item {
  constructor() {
    this.a = 1;
  }
}

class Partial {
  constructor() {
    this.b = 2;
  }
}

const box = new Box();
const partial = new Partial();
box.item = partial;
console.log("partial", box.item === partial, Object.keys(box.item).join());
const item = new Item();
box.item = item;
console.log("item", box.item === item, Object.keys(box.item).join());
