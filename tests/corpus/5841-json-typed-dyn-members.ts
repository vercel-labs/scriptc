// JSON.stringify over typed records whose members are checked-dynamic
// values: the undeclared properties a checked record keeps from its source,
// and the entries of an `unknown` index signature. Each member follows
// SerializeJSONProperty: toJSON runs with the member's key, getters are
// read, a Buffer becomes its { type, data } form, undefined, function and
// symbol results drop, and a circular structure throws V8's TypeError.
type Point = { a: number };
type Bag = { a: number; [key: string]: unknown };

const report = (label: string, run: () => string | undefined): void => {
  try {
    console.log(label, run());
  } catch (error) {
    const e = error as Error;
    console.log(label, e.name);
    console.log(e.message);
  }
};

const source: any = JSON.parse('{"a":1,"b":"two"}');
source.stamp = { toJSON: (key: string) => `stamp:${key}` };
source.gone = { toJSON: () => undefined };
source.bytes = Buffer.from("hi");
Object.defineProperty(source, "computed", { get: () => 42, enumerable: true });
source.list = [1, { toJSON: (key: string) => `item:${key}` }];
const point = source as Point;
report("source", () => JSON.stringify(point));
report("source pretty", () => JSON.stringify(point, null, 2));
report("source nested", () => JSON.stringify({ point, n: 2 }));
report("source array", () => JSON.stringify([point, point]));

const bag: Bag = { a: 1 };
bag.stamp = { toJSON: (key: string) => `stamp:${key}` };
bag.gone = { toJSON: () => undefined };
bag.data = JSON.parse('{"x":[1,2,{"y":null}]}');
bag.nothing = undefined;
bag.order = JSON.parse('{"b":1,"2":"two","a":2,"0":"zero"}');
const layered: any = JSON.parse('{"level":{"items":[1,{"x":null}]}}');
layered.level.items.push({ toJSON: (key: string) => `deep:${key}` });
bag.deep = layered;
const hidden: any = JSON.parse('{"shown":1}');
Object.defineProperty(hidden, "hidden", { value: 2, enumerable: false });
bag.hidden = hidden;
let nested: any = JSON.parse('{"end":true}');
for (let i = 0; i < 40; i++) nested = { i, nested };
bag.nested = nested;
report("bag", () => JSON.stringify(bag));
report("bag in array", () => JSON.stringify([bag]));

const self: any = JSON.parse('{"k":1}');
self.self = self;
const cyclic: any = JSON.parse('{"a":1,"x":{"k":2}}');
cyclic.x.self = cyclic.x;
report("source circular", () => JSON.stringify(cyclic as Point));
const deep: any = JSON.parse('{"a":1,"x":{"y":{"z":{"w":{"v":{}}}}}}');
deep.x.y.z.w.v.back = deep.x;
report("source deep circular", () => JSON.stringify(deep as Point));
const circular: Bag = { a: 1 };
circular.loop = self;
report("bag circular", () => JSON.stringify(circular));
report("bag circular nested", () => JSON.stringify({ outer: circular }));

const shared: any = JSON.parse('{"v":1}');
const twice: Bag = { a: 1, first: shared, second: shared };
report("bag shared", () => JSON.stringify(twice));

const big: any = JSON.parse('{"a":1}');
big.n = 1n;
report("source bigint", () => JSON.stringify(big as Point));
const throwing: Bag = { a: 1 };
throwing.bad = {
  toJSON: () => {
    throw new RangeError("from toJSON");
  },
};
report("bag throwing", () => JSON.stringify(throwing));
