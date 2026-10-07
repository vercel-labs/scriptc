class Root { marker = 1; }
class Item extends Root { value = 4; }
class Handler {
  run(b:Bag<Item|undefined>|undefined,v:Item|undefined):void { b!.add(v); console.log(b!.contains(v), b!.values.length); }
  read(b: Bag<Item | undefined>): Item | undefined { return b.read(); }
  inherit(b: Derived<number>): number { return b.value + b.marker; }
}
class GenericBase<T> extends Root { value: T; constructor(value: T) { super(); this.value = value; } }
class Derived<T> extends GenericBase<T> {}
class Bag<T> extends Root {
  values: T[] = [];
  add(v: T): void { this.values.push(v); }
  contains(v:T):boolean { return this.values.includes(v); }
  read(): T | undefined { return this.values[0]; }
}
const handler = new Handler();
const bag = new Bag<Item | undefined>();
handler.run(bag, undefined);
handler.run(bag, new Item());
console.log(handler.read(bag));
console.log(handler.inherit(new Derived(3)));
try { handler.run(undefined, undefined); } catch(e) { console.log(e instanceof TypeError); }
