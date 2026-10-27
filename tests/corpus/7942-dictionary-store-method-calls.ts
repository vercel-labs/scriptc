// Stores into dictionaries whose values cannot be functions leave class
// methods in place.
interface Data {
  items: string[];
}
class Store {
  data: Data = { items: [] };
  get(): Data {
    return this.data;
  }
}
class Counter {
  n = 0;
  add(): number {
    return ++this.n;
  }
}
interface Settings {
  groups: Record<string, Record<string, string>>;
}
interface Tree {
  [key: string]: Tree;
}
function addGroup(settings: Settings, name: string): void {
  settings.groups[name] = {};
}
function grow(tree: Tree, name: string): Tree {
  tree[name] = {};
  return tree[name]!;
}
const settings: Settings = { groups: {} };
addGroup(settings, "colours");
addGroup(settings, "fonts");
settings.groups["colours"]!["fg"] = "red";
console.log(Object.keys(settings.groups).join(","), JSON.stringify(settings.groups));
const tree: Tree = {};
grow(grow(tree, "a"), "b");
console.log(JSON.stringify(tree));
const store = new Store();
store.get().items.push("a");
store.get().items.push("b");
const counter = new Counter();
let total = 0;
for (let i = 0; i < 1000; i++) total += counter.add();
console.log(store.data.items.length, total, typeof counter.add);
