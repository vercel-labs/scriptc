// A string-keyed dictionary whose values are dictionaries cannot hold a
// function, so storing into it under a key known only at runtime leaves class
// methods in place: their calls stay direct, and a record a method returns is
// the record the instance holds, so writes through it are kept.
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
  count = 0;
  bump(): number {
    return ++this.count;
  }
}
interface Settings {
  groups: Record<string, Record<string, string>>;
}
function addGroup(settings: Settings, name: string): void {
  settings.groups[name] = {};
}

const settings: Settings = { groups: {} };
const name = process.argv.length > 99 ? "never" : "colours";
addGroup(settings, name);
const group = settings.groups[name];
if (group !== undefined) group["sky"] = "blue";
const store = new Store();
store.get().items.push("a");
store.get().items.push("b");
const counter = new Counter();
counter.bump();
console.log(JSON.stringify(settings.groups), store.data.items.join(","), counter.bump());
