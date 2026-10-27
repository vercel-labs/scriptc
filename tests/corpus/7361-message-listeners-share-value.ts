import { MessageChannel, type MessagePort } from "node:worker_threads";

// Listeners of one message share its value, as in Node: a typed listener
// that runs after an untyped one sees the changes the untyped one made,
// and a listener on a discriminated union reads the arm its discriminator
// names.
type Item = { id: number; name: string };
type Shape = { kind: "circle"; size: number } | { kind: "square"; size: number; corner: string };

const lines: string[] = [];
let pending = 0;
const ports: MessagePort[] = [];
function finish(): void {
  if (--pending > 0) return;
  for (const line of lines) console.log(line);
  for (const port of ports) port.close();
}

const shared = new MessageChannel();
ports.push(shared.port1);
shared.port1.on("message", (value: Item) => {
  lines.push(`typed first ${value.id} ${value.name}`);
});
shared.port1.on("message", (value: any) => {
  value.id = value.id * 10;
  value.name = `${value.name}!`;
});
shared.port1.on("message", (value: Item) => {
  lines.push(`typed after ${value.id} ${value.name}`);
  finish();
});
pending += 2;
shared.port2.postMessage({ id: 1, name: "a" });
shared.port2.postMessage({ id: 2, name: "b" });

const shapes = new MessageChannel();
ports.push(shapes.port1);
shapes.port1.on("message", (shape: Shape) => {
  if (shape.kind === "circle") lines.push(`circle ${shape.size}`);
  else lines.push(`square ${shape.size} ${shape.corner}`);
  finish();
});
pending += 2;
shapes.port2.postMessage({ kind: "circle", size: 3 });
shapes.port2.postMessage({ kind: "square", size: 4, corner: "round" });
