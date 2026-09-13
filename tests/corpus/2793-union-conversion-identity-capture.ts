class Item {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

function same(left: Item | undefined, right: Item | null): boolean {
  return left === right;
}

const item = new Item("x");
console.log("identity", same(item, item), same(undefined, null));

function describe(value: number | symbol | undefined): string {
  if (typeof value === "undefined") return "undefined";
  if (typeof value !== "symbol") return "number=" + value;
  return value.toString();
}
console.log("convert", describe(7), describe(Symbol("s")), describe(undefined));

const { groups } = /(?<word>\w+)/.exec("hello")!;
console.log("capture", groups!.word);
