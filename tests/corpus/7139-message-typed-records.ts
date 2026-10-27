import { MessageChannel } from "node:worker_threads";

// Typed records posted on a MessageChannel arrive as plain objects with
// the same keys, order and values as in Node: optional fields present and
// absent, nested records, a record reached twice, a record nested deeper
// than the encoder recurses, a record parsed with undeclared keys, and a
// function-valued field, which postMessage rejects.
type Point = { x: number; y: number };
type Item = { id: number; name: string; done: boolean; pos: Point; note?: string };
type Pair = { left: Point; right: Point };
type Link = { value: number; next?: Link };

const { port1, port2 } = new MessageChannel();
const lines: string[] = [];
const expected = 7;
port1.on("message", (value: unknown) => {
  let checks = "";
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if ("left" in object) checks += ` same ${object["left"] === object["right"]}`;
    const pos = object["pos"] as Record<string, unknown> | undefined;
    if (pos !== undefined) checks += ` negative zero ${Object.is(pos["x"], -0)}`;
  }
  lines.push(JSON.stringify(value) + checks);
  if (lines.length === expected) {
    for (const line of lines) console.log(line);
    port1.close();
  }
});

const item: Item = { id: 1, name: "first", done: false, pos: { x: 1, y: 2 } };
port2.postMessage(item);
const noted: Item = { id: 2, name: "", done: true, pos: { x: -0, y: 0.5 }, note: "n" };
port2.postMessage(noted);

const shared: Point = { x: 3, y: 4 };
const pair: Pair = { left: shared, right: shared };
port2.postMessage(pair);

let chain: Link = { value: 0 };
for (let i = 1; i < 40; i++) chain = { value: i, next: chain };
port2.postMessage(chain);

const parsed = JSON.parse('{"y":6,"extra":true,"x":5}') as Point;
port2.postMessage(parsed);
port2.postMessage({ x: 7, y: 8 } as Point);
port2.postMessage([item.pos, noted.pos]);

type WithFunction = { id: number; run: () => number };
const bad: WithFunction = { id: 9, run: () => 1 };
try {
  port2.postMessage(bad);
} catch (error) {
  console.log("rejected", (error as Error).name);
}

// Fields that hold objects with getters: each field's value is read
// completely, its getters included, before the next field's, as in Node.
type Holder = { id: number; first: unknown; second: unknown };
const reads: string[] = [];
const getters: Holder = {
  id: 1,
  first: {
    get a() {
      reads.push("first.a");
      return 1;
    },
    nested: {
      get b() {
        reads.push("first.nested.b");
        return 2;
      },
    },
  },
  second: {
    get c() {
      reads.push("second.c");
      return 3;
    },
  },
};
const { port1: getterPort, port2: getterSender } = new MessageChannel();
getterSender.postMessage(getters);
console.log("getter order", reads.join(","));
getterPort.close();
