// `typeof globalThis.fetch` under @types/node takes `string | URL | Request`:
// unions holding URL handles beside fetch handles compile (URL boxes by
// reference into the checked-dynamic representation), and a custom fetch
// cast to that type through `unknown` keeps working, including an extra
// init member written through a record view (the dispatcher pattern).
import * as http from "node:http";
type FetchImpl = typeof globalThis.fetch;
interface DispatchingInit {
  method?: string;
  headers?: Record<string, string>;
  dispatcher?: { name: string };
}
function customFetch(input: string | URL, init?: DispatchingInit): Promise<Response> {
  console.log("custom fetch", typeof input === "string" ? "string" : "url", init?.dispatcher?.name ?? "none");
  return fetch(input, { method: init?.method, headers: init?.headers });
}
const server = http.createServer((req, res) => res.end(`ok ${req.method} ${req.url}`));
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  const impl: FetchImpl = customFetch as unknown as FetchImpl;
  const init: RequestInit = { method: "POST" };
  (init as Record<string, unknown>).dispatcher = { name: "pinned" };
  const res = await impl(`http://127.0.0.1:${port}/a`, init);
  console.log(res.status, await res.text());
  const viaUrl = await impl(new URL(`http://127.0.0.1:${port}/b`));
  console.log(viaUrl.status, await viaUrl.text());
  const direct = await fetch(new URL(`http://127.0.0.1:${port}/c`));
  console.log(direct.status, await direct.text());
  server.close();
});

function describeInput(input: string | Request | URL): string {
  if (typeof input === "string") return `string ${input}`;
  if (input instanceof URL) return `url ${input.href} ${input.hostname}`;
  return `request ${input.method} ${input.url}`;
}
console.log(describeInput("http://a.test/x"));
const u = new URL("http://b.test:8080/p?q=1");
console.log(describeInput(u));
console.log(describeInput(new Request("http://c.test/r", { method: "PUT" })));
const items: (string | URL | Request)[] = [u, "s"];
console.log(items.length, items[0] === u, String(items[0]));
let slot: string | URL | Request = u;
if (slot instanceof URL) { slot.pathname = "/changed"; }
console.log(u.href);
const params: string | Request | URL = new URL("http://d.test/?b=2");
console.log(typeof params === "string" ? params : params instanceof URL ? params.searchParams.get("b") : "req");
