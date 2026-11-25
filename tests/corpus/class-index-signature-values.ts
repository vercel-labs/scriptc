// A class's index signature with a `number` key or a typed value: the
// properties live on the instance, a missing one reads undefined, and a
// present one reads as the declared type, as in Node.
class List {
  private items: string[] = ["a", "b"];
  [index: number]: string;
  get length(): number {
    return this.items.length;
  }
}
const l = new List();
console.log(l[0], l.length);

class Strings {
  [index: number]: string;
  length = 0;
  push(s: string): void {
    this[this.length] = s;
    this.length++;
  }
  item(i: number): string | null {
    return i < this.length ? this[i] : null;
  }
}
const strings = new Strings();
strings.push("a");
strings.push("b");
console.log(strings[0], strings[1], strings.length, strings.item(1), String(strings[5]));
console.log(strings[1].toUpperCase(), strings[0].length);

class Loose {
  [index: number]: any;
  length = 0;
  push(value: unknown): void {
    this[this.length] = value;
    this.length++;
  }
}
const loose = new Loose();
loose.push("x");
loose.push(2);
console.log(loose[0], loose[1], loose[2], Object.keys(loose).join(","), JSON.stringify(loose));

class Item {
  name: string;
  constructor(name: string) { this.name = name; }
}
class NodeList {
  [index: number]: Item;
  length = 0;
  add(item: Item): void { this[this.length] = item; this.length++; }
  item(i: number): Item | null { return i >= 0 && i < this.length ? this[i] : null; }
}
class LiveList extends NodeList {
  first(): Item { return this[0]; }
}
const list = new LiveList();
list.add(new Item("a"));
list.add(new Item("b"));
console.log(list[0].name, list[1].name, list.length, list.first().name, list.item(1)?.name, list.item(4));
console.log(0 in list, 7 in list, Object.keys(list).join(","));
console.log(JSON.stringify(list));
const missing = list[9];
console.log(missing === undefined, typeof missing);
try { console.log(list[9].name); } catch (e) { console.log(String(e)); }
function describe(item: Item): string { return item === undefined ? "absent" : item.name; }
console.log(describe(list[0]), describe(list[3]));
// A numeric string key reads the `number` index signature too.
const zero = "0";
function at(key: "1" | "6"): Item { return list[key]; }
console.log(list["1"].name, list["8"], typeof list["8"], list[zero].name, at("1").name, at("6"));

class Counts {
  [key: string]: number;
}
const c = new Counts();
c.apples = 1;
c["pears"] = 2;
if (c.plums === undefined) c.plums = 9;
const keys: string[] = [];
for (const k of Object.keys(c)) keys.push(k + "=" + c[k]);
console.log(keys.join(" "), c.cherries, String(c.apples + 1));

class Flags {
  readonly [flag: string]: boolean;
  constructor() { (this as { [flag: string]: boolean }).on = true; }
}
const f = new Flags();
console.log(f.on, f.off, String(f.off));
