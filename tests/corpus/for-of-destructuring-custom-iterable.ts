// Destructuring the value a for-of binds over a class with its own
// [Symbol.iterator]: an array pattern, an object pattern with index keys,
// and a pattern whose element the iterator hands out as an object.
class Pair {
  private items: string[][] = [
    ["id", "x"],
    ["class", "y"],
  ];
  [Symbol.iterator](): { next(): { value: string[]; done: boolean } } {
    let i = 0;
    const items = this.items;
    return {
      next(): { value: string[]; done: boolean } {
        if (i >= items.length) return { value: [], done: true };
        const v = items[i];
        i++;
        return { value: v, done: false };
      },
    };
  }
}
const pairs = new Pair();
for (const [name, value] of pairs) console.log(name + "=" + value);
for (const { 0: name, 1: value } of pairs) console.log(name + ":" + value);

// An iterator that hands out records: an object pattern by name.
class Attrs {
  private all: { name: string; value: string }[] = [
    { name: "href", value: "/" },
    { name: "title", value: "home" },
  ];
  [Symbol.iterator](): { next(): { value: { name: string; value: string }; done: boolean } } {
    let i = 0;
    const all = this.all;
    return {
      next(): { value: { name: string; value: string }; done: boolean } {
        if (i >= all.length) return { value: { name: "", value: "" }, done: true };
        const v = all[i];
        i++;
        return { value: v, done: false };
      },
    };
  }
}
for (const { name, value } of new Attrs()) console.log(name + " -> " + value);
