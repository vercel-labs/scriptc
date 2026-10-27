// A Duplex.from body may take { signal } (duplexify.js's fromAsyncGen):
// destroy aborts it with the destroy error, or with an AbortError when
// there is none, and compose passes it to its function stages.
import { Duplex, Readable, compose } from "node:stream";
import { once } from "node:events";

const d = Duplex.from(async function* (source, { signal }) {
  console.log("body", typeof signal, signal.aborted);
  signal.addEventListener("abort", () => console.log("abort event", signal.aborted, signal.reason));
  for await (const chunk of source) yield String(chunk).toUpperCase();
  console.log("source ended");
});
d.on("data", (c) => console.log("data", c));
d.write("a");
d.write("b");
await new Promise((r) => setTimeout(r, 10));
d.destroy();
await once(d, "close");
console.log("closed d");

const seen = [];
const fin = Duplex.from(async function (source, { signal }) {
  signal.addEventListener("abort", () => console.log("abort", seen.join(",")));
  for await (const chunk of source) seen.push(String(chunk));
  console.log("done", signal.aborted);
});
fin.on("finish", () => console.log("finish"));
fin.write("1");
fin.write("2");
fin.end();
await once(fin, "close");
console.log("closed fin");

const boom = new Error("boom");
const e = Duplex.from(async function (source, { signal }) {
  signal.addEventListener("abort", () => console.log("e abort", String(signal.reason), signal.reason === boom));
  await new Promise((r) => setTimeout(r, 50));
});
e.on("error", (err) => console.log("e error", err === boom));
setTimeout(() => e.destroy(boom), 5);
await new Promise((r) => e.on("close", r));
console.log("closed e");

const c = compose(
  async function* (source, { signal }) {
    for await (const chunk of source) yield `${chunk}!${signal.aborted}`;
  },
  async function* (source, { signal }) {
    for await (const chunk of source) yield chunk.toUpperCase();
  },
);
Readable.from(["a", "b"]).pipe(c);
c.on("data", (x) => console.log("compose", String(x)));
c.on("end", () => console.log("compose end"));
