// fetch() response bodies from a local server as web ReadableStreams: for
// await, tee, text() after a member read, and a break out of the
// iteration, with the body's bodyUsed after them.
import http from "node:http";
const decoder = new TextDecoder();
const server = http.createServer((req, res) => {
  res.write("chunk-one;");
  setTimeout(() => { res.end("chunk-two"); }, 5);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const a = await fetch(url);
let s = "";
for await (const c of a.body) s += decoder.decode(c);
console.log("for await", s, a.bodyUsed);
const b = await fetch(url);
const [x, y] = b.body.tee();
const readAll = async (st) => { let t = ""; for await (const c of st) t += decoder.decode(c); return t; };
console.log("tee", await readAll(x), await readAll(y));
const c = await fetch(url);
void c.body.values;
console.log("text", await c.text());
const d = await fetch(url);
for await (const chunk of d.body) { console.log("first", decoder.decode(chunk)); break; }
console.log("after break", d.bodyUsed);
server.close();
