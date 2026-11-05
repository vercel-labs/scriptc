// A 'line' listener that closes the interface: the 'close' event runs at
// once, the rest of the lines already split from the same chunk are still
// delivered, as in Node, and later chunks are not read.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const first = createInterface({ input: Readable.from(["x\ny\nz\n", "after\n"]) });
first.on("line", (line: string) => {
  console.log("line", line);
  if (line === "y") first.close();
});
first.on("close", () => console.log("closed"));

// Two listeners; the second closes on the first line of a chunk of three.
const second = createInterface({ input: Readable.from(["a\nb\nc"]) });
const order: string[] = [];
second.on("line", (line: string) => order.push(`one:${line}`));
second.on("line", (line: string) => {
  order.push(`two:${line}`);
  if (line === "a") second.close();
});
second.on("close", () => order.push("close"));
setTimeout(() => console.log(order.join(" ")), 20);
