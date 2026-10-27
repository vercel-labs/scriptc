// A generic method called through a `Pick` view of a class compiles
// against that class. A view that holds an instance of a structurally
// compatible, unrelated class is refused: Node calls that class's own
// method.
class Store {
  load<T>(key: string, map: (text: string) => T): T {
    return map(key);
  }
}
class Mirror {
  load<T>(key: string, map: (text: string) => T): T {
    return map(`${key}!`);
  }
}
const view: Pick<Store, "load"> = new Mirror();
console.log(view.load("k", (text) => text.length));
