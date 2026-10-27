// JSON.stringify of typed records and arrays reached through `unknown`:
// members are read from the native values in key order, toJSON receives the
// member key (an index string inside arrays), undefined members drop out of
// objects and become null in arrays, and the key list is fixed before any
// toJSON runs.
interface Product {
  id: string;
  name: string;
  priceCents: number;
  tags: string[];
  note?: string;
}

function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, undefined, space);
}

const products: Product[] = [
  { id: "p1", name: "Keyboard", priceCents: 12900, tags: ["hardware", "input"] },
  { id: "p2", name: "Quote \"and\" slash \\", priceCents: 0.5, tags: [], note: "café ☕" },
];
console.log(stringify({ products, count: products.length }));
console.log(stringify(products, 2));
const second: Product = products[1]!;
delete second.note;
console.log(stringify(second));

class Money {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  toJSON(key: string): string {
    return `${key}:${(this.cents / 100).toFixed(2)}`;
  }
}
const prices: Money[] = [new Money(100), new Money(2550)];
console.log(stringify(prices), stringify({ total: new Money(5) }));

const numbers: number[] = [1, -0, NaN, Infinity, 2.5, 1e21];
console.log(stringify(numbers));
const maybe: (string | undefined)[] = ["a", undefined, "c"];
console.log(stringify(maybe), stringify({ maybe }));
const nested: number[][] = [[1, 2], [], [3]];
console.log(stringify(nested, 1));

// a toJSON that deletes a later optional field: the field was present when
// the key list was taken, so its (now undefined) value is dropped
interface Order {
  first: { toJSON(): string };
  note?: string;
}
const order: Order = { first: { toJSON: () => "x" }, note: "kept?" };
order.first = {
  toJSON: () => {
    delete order.note;
    return "first";
  },
};
console.log(stringify(order));

// circular structures through capsules report the path
interface Node {
  name: string;
  children: Node[];
}
const root: Node = { name: "root", children: [] };
root.children.push({ name: "leaf", children: [root] });
try {
  stringify(root);
} catch (error) {
  console.log((error as Error).message);
}
