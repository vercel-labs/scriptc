type Item = { label: string; count: number };

class Source {
  static *pairs(): Generator<number[], void, undefined> {
    yield [1, 2];
    yield [3, 4];
  }

  static *items(): Generator<Item, void, undefined> {
    yield { label: "sync", count: 9 };
  }

  static async *asyncPairs(): AsyncGenerator<number[], void, undefined> {
    yield [5, 6];
    await Promise.resolve();
    yield [7, 8];
  }

  static async *asyncItems(): AsyncGenerator<Item, void, undefined> {
    yield { label: "async", count: 10 };
  }
}

const Expression = class {
  static *values(): Generator<number, void, undefined> {
    yield 11;
  }

  static async *asyncValues(): AsyncGenerator<number, void, undefined> {
    yield 12;
  }
};

class InstanceSource {
  *values(): Generator<number, void, undefined> {
    yield 13;
    yield 14;
  }
}

class ChildSource extends InstanceSource {}

let left = 0;
let right = 0;
for ([left, right] of Source.pairs()) console.log("assign", left, right);
for (const [a, b] of Source.pairs()) console.log("const", a, b);
for (let [a, b] of Source.pairs()) console.log("let", a, b);
var syncA = 0, syncB = 0;
for (var [syncA, syncB] of Source.pairs()) {}
console.log("var", syncA, syncB);
for (const { label, count } of Source.items()) console.log("object", label, count);
for (const value of Expression.values()) console.log("expression", value);
const child: InstanceSource = new ChildSource();
for (const value of child.values()) console.log("instance", value);

async function main(): Promise<void> {
  for await ([left, right] of Source.asyncPairs()) console.log("async assign", left, right);
  for await (const [a, b] of Source.asyncPairs()) console.log("async const", a, b);
  for await (let [a, b] of Source.asyncPairs()) console.log("async let", a, b);
  var asyncA = 0, asyncB = 0;
  for await (var [asyncA, asyncB] of Source.asyncPairs()) {}
  console.log("async var", asyncA, asyncB);
  for await (const { label, count } of Source.asyncItems()) console.log("async object", label, count);
  for await (const value of Expression.asyncValues()) console.log("async expression", value);
}

void main();
