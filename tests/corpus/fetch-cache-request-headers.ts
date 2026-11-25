// RequestInit.cache shapes the request headers the way Node's
// HTTP-network-or-cache fetch does: no-store and reload send Pragma:
// no-cache and, unless the program set one, Cache-Control: no-cache;
// no-cache sends Cache-Control: max-age=0; and a default-mode request
// carrying a conditional header revalidates like no-store. A Request
// carries its cache mode into the fetch the same way.
import { createServer } from "node:http";

function shown(raw: string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (name === "pragma" || name === "cache-control" || name === "if-none-match") {
      pairs.push(`${name}=${raw[i + 1]}`);
    }
  }
  pairs.sort();
  return pairs.length > 0 ? pairs.join(" ") : "-";
}

const server = createServer((req, res) => {
  res.end(shown(req.rawHeaders));
});

server.listen(0, "127.0.0.1", async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/`;
  const cases: [string, RequestInit][] = [
    ["default", {}],
    ["no-store", { cache: "no-store" }],
    ["no-cache", { cache: "no-cache" }],
    ["reload", { cache: "reload" }],
    ["force-cache", { cache: "force-cache" }],
    ["no-store with user cache-control", { cache: "no-store", headers: { "cache-control": "max-age=60" } }],
    ["reload with user pragma", { cache: "reload", headers: { pragma: "x" } }],
    ["no-cache with user cache-control", { cache: "no-cache", headers: { "cache-control": "no-cache" } }],
    ["default with conditional", { headers: { "if-none-match": '"abc"' } }],
    ["force-cache with conditional", { cache: "force-cache", headers: { "if-none-match": '"abc"' } }],
  ];
  for (const [label, init] of cases) {
    const response = await fetch(url, init);
    console.log(label, await response.text());
  }
  const request = new Request(url, { cache: "no-store" });
  const response = await fetch(request);
  console.log("request input", await response.text());
  server.close();
});
