// A header value Node's stack will not send: fetch fails with TypeError
// "fetch failed" whose cause is undici's InvalidArgumentError before it opens
// the request, so the server sees nothing — while Headers itself stores the
// value, and a tab or a trailing newline (trimmed away) is sent as usual.
import { createServer } from "node:http";
const seen: string[] = [];
const server = createServer((req, res) => {
  seen.push(String(req.headers["x-test"]));
  res.end("ok");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;
async function show(label: string, value: string): Promise<void> {
  try {
    const res = await fetch(base + "/" + label, { headers: { "x-test": value } });
    console.log(label, "sent", res.status, JSON.stringify(seen[seen.length - 1]));
  } catch (e) {
    const error = e as any;
    console.log(label, "throw", error.constructor.name, JSON.stringify(error.message), JSON.stringify(error.cause?.name), JSON.stringify(error.cause?.code), JSON.stringify(error.cause?.message));
  }
}
await show("ctrl01", "a\u0001b");
await show("del", "a\u007fb");
await show("vt", "a\u000bb");
await show("tab", "a\tb");
await show("trailnl", "line\n");
const headers = new Headers();
headers.append("x-test", "h\u0001i");
try {
  const res = await fetch(base + "/obj", { headers });
  console.log("headers obj", "sent", res.status, JSON.stringify(seen[seen.length - 1]));
} catch (e) {
  const error = e as any;
  console.log("headers obj", "throw", error.constructor.name, JSON.stringify(error.message), JSON.stringify(error.cause?.code));
}
const request = new Request(base + "/req", { headers: { "x-test": "a\u0001b" } });
console.log("request built", request.headers.get("x-test") === "a\u0001b");
try {
  await fetch(request);
  console.log("request fetch", "sent");
} catch (e) {
  const error = e as any;
  console.log("request fetch", "throw", JSON.stringify(error.message), JSON.stringify(error.cause?.code));
}
console.log("seen", JSON.stringify(seen));
server.close();
