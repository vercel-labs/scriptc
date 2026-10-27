// fetch() sends its header list's combined values: repeated Set-Cookie
// request headers go out as one line, the values joined by ", ", at the
// position of the first one, whatever form the headers were given in.
import { createServer } from "node:http";

function shown(raw: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "connection" || lower.startsWith("accept") || lower.startsWith("sec-") || lower === "user-agent") continue;
    lines.push(`${name}: ${raw[i + 1]}`);
  }
  return lines.join(" | ");
}

const server = createServer((req, res) => {
  res.end(shown(req.rawHeaders));
});

server.listen(0, "127.0.0.1", async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/`;

  const headers = new Headers();
  headers.append("set-cookie", "a=1");
  headers.append("x-first", "1");
  headers.append("set-cookie", "b=2");
  console.log(await (await fetch(url, { headers })).text());

  const pairs: [string, string][] = [
    ["x-before", "0"],
    ["set-cookie", "c=3"],
    ["set-cookie", "d=4; Path=/"],
  ];
  console.log(await (await fetch(url, { headers: pairs })).text());

  console.log(await (await fetch(url, { headers: { "set-cookie": "e=5", "x-record": "r" } })).text());

  const single = new Headers({ "set-cookie": "only=1" });
  console.log(await (await fetch(url, { headers: single })).text());
  server.close();
});
