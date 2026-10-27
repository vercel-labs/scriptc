// Handlers typed `Promise<R | void> | R | void` (an extension event
// handler) and members typed `(p: string) => boolean | Promise<boolean>`
// (a tool's filesystem operations): sync and async implementations share
// one slot, and the caller awaits whatever comes back.

interface Ops {
  exists: (absolutePath: string) => boolean | Promise<boolean>;
}
const syncOps: Ops = { exists: (p) => p.length > 3 };
const asyncOps: Ops = { exists: async (p) => p.startsWith("/") };

interface Result {
  block: boolean;
  reason: string;
}
type Handler = (n: number) => Promise<Result | void> | Result | void;

const handlers: Handler[] = [];
handlers.push((n) => {
  if (n > 5) return { block: true, reason: "sync big" };
});
handlers.push(async (n) => {
  if (n === 3) return { block: true, reason: "async three" };
});
handlers.push((n) => (n === 4 ? Promise.resolve({ block: false, reason: "promise four" }) : undefined));

// Named functions flow into the slot through their declared types.
async function asyncNamed(n: number): Promise<Result> {
  return { block: n === 2, reason: "async named" };
}
function syncNamed(n: number): Result {
  return { block: n === 1, reason: "sync named" };
}
function voidNamed(n: number): void {
  console.log("void handler saw", n);
}
async function asyncVoid(n: number): Promise<void> {
  console.log("async void handler saw", n);
}
const named: Handler[] = [asyncNamed, syncNamed, voidNamed, asyncVoid];

async function run(list: Handler[], n: number): Promise<string> {
  for (const h of list) {
    const r = await h(n);
    if (r && r.block) return r.reason;
  }
  return "none";
}

// A class-instance arm beside null and the promise arm.
class Response {
  status: number;
  constructor(status: number) {
    this.status = status;
  }
}
type Route = (path: string) => Response | null | Promise<Response | null>;
const routes: Route[] = [
  (path) => (path === "/sync" ? new Response(200) : null),
  async (path) => (path === "/async" ? new Response(202) : null),
];
async function route(path: string): Promise<string> {
  for (const r of routes) {
    const res = await r(path);
    if (res instanceof Response) return path + " " + res.status;
  }
  return path + " 404";
}

async function main(): Promise<void> {
  console.log(await syncOps.exists("/tmp/x"), await syncOps.exists("/a"));
  console.log(await asyncOps.exists("/tmp/x"), await asyncOps.exists("tmp"));
  for (const n of [1, 3, 4, 7]) console.log(n, await run(handlers, n));
  for (const n of [1, 2, 9]) console.log(n, await run(named, n));
  for (const path of ["/sync", "/async", "/missing"]) console.log(await route(path));
}
main();
