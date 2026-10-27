import { MessageChannel } from "node:worker_threads";

// 'message' listeners with typed parameters on MessageChannel ports. A
// message with the parameter's exact layout, and one with other keys,
// shared values or other kinds, reach the listener with the same values as
// in Node.
type Item = { id: number; name: string; done: boolean };
type Nested = { label: string; item: Item };

const { port1, port2 } = new MessageChannel();
// Each port's lines print in delivery order once every message arrived.
const lines: string[] = [];
const nestedLines: string[] = [];
const otherLines: string[] = [];
let pending = 0;
function finish(): void {
  if (--pending === 0) {
    for (const line of [...lines, ...nestedLines, ...otherLines]) console.log(line);
    port1.close();
    channel.port1.close();
    other.port1.close();
  }
}

port1.on("message", (value: number | string | Item | null | undefined) => {
  if (value === null || value === undefined) lines.push(`unit ${String(value)}`);
  else if (typeof value === "number") lines.push(`number ${value.toFixed(2)}`);
  else if (typeof value === "string") lines.push(`string ${value.length} ${value}`);
  else lines.push(`item ${value.id} ${value.name} ${value.done} ${JSON.stringify(value)}`);
  finish();
});

const sent: unknown[] = [
  1.5,
  -0,
  "",
  "héllo wörld",
  null,
  undefined,
  { id: 1, name: "first", done: false },
  { id: 2, name: "", done: true },
  // An extra key stays beside the record.
  { id: 4, name: "extra", done: false, note: "kept" },
];
pending += sent.length;
for (const value of sent) port2.postMessage(value);

// Nested records, a value shared by two fields, and a second listener
// that reads the message untyped.
const channel = new MessageChannel();
channel.port1.on("message", (value: Nested) => {
  nestedLines.push(`nested ${value.label} ${value.item.id} ${value.item.name} ${JSON.stringify(value)}`);
  finish();
});
channel.port1.on("message", (value: unknown) => {
  nestedLines.push(`untyped ${JSON.stringify(value)}`);
  finish();
});
const shared = { id: 5, name: "shared", done: true };
const nested: unknown[] = [
  { label: "plain", item: { id: 6, name: "six", done: false } },
  { label: "shared", item: shared, again: shared },
];
pending += 2 * nested.length;
for (const value of nested) channel.port2.postMessage(value);

// once listeners, and a listener added while the port delivers.
const other = new MessageChannel();
other.port1.once("message", (value: Item) => {
  otherLines.push(`once ${value.id} ${value.name}`);
  other.port1.on("message", (later: number) => {
    otherLines.push(`later ${later}`);
    finish();
  });
  finish();
});
pending += 3;
other.port2.postMessage({ id: 7, name: "seven", done: true });
other.port2.postMessage(8);
other.port2.postMessage(9);
