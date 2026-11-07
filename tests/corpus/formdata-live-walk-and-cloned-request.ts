// Two things a program that uses FormData must see as Node does.
//
// forEach walks the live entry list, as entries() does: an entry appended by
// the callback is visited, and a removal moves the rest down under the walk.
//
// A cloned Request is sent like its original: a buffered body with its own
// content-length, a body-less request with none.
import { createServer } from "node:http";

const grown = new FormData();
grown.append("a", "1");
grown.append("b", "2");
const visited: string[] = [];
grown.forEach((value, key) => {
  visited.push(`${key}=${String(value)}`);
  if (key === "a") grown.append("c", "3");
  if (key === "c") grown.append("d", "4");
});
console.log(visited.join(" "), [...grown.keys()].join(","));

const shrunk = new FormData();
for (const name of ["p", "q", "r", "s"]) shrunk.append(name, name.toUpperCase());
const walked: string[] = [];
shrunk.forEach((_value, key) => {
  walked.push(key);
  if (key === "q") shrunk.delete("p");
});
console.log(walked.join(","), [...shrunk.keys()].join(","));

// The iterators walk the same live list.
const iterated = new FormData();
iterated.append("x", "1");
const seen: string[] = [];
for (const [key] of iterated) {
  seen.push(key);
  if (key === "x") iterated.append("y", "2");
  if (key === "y") iterated.set("z", "3");
}
console.log(seen.join(","));

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    console.log(
      req.method,
      "length",
      req.headers["content-length"],
      "encoding",
      req.headers["transfer-encoding"],
      JSON.stringify(body),
    );
    res.end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const url = `http://127.0.0.1:${port}/`;

const text = new Request(url, { method: "POST", body: "hello, clone" });
const textCopy = text.clone();
console.log(await (await fetch(textCopy)).text());
console.log(await (await fetch(text)).text());

const bytes = new Request(url, { method: "PUT", body: new Uint8Array([104, 105]) });
console.log(await (await fetch(bytes.clone())).text());

const plain = new Request(url);
console.log(await (await fetch(plain.clone())).text());

const removal = new Request(url, { method: "DELETE" });
console.log(await (await fetch(removal.clone())).text());

server.close();
