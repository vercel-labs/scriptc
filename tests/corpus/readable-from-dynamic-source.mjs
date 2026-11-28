// Readable.from over a source a JavaScript call holds as a checked-dynamic
// value: the checker infers the stream class through the member that
// answers it, and the value crosses into that class where from() opens the
// source's iterator, as Node's from() opens a stream source.
import { Readable } from "node:stream";

const inner = {
  make: () => Readable.from(["x", "y"]),
};
const wrapper = Readable.from(inner.make());
wrapper.on("data", (chunk) => console.log("data", String(chunk)));
wrapper.on("end", () => console.log("end"));
