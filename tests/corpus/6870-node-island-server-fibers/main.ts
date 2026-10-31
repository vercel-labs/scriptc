// @requires-libnode
// An HTTP server whose async request handler awaits island promises, calls
// island functions, extends an island class and arms timers, while an
// island client drives it (a long-running service's shape): the handler's
// continuations run as runtime jobs that Node's loop
// dispatches, possibly on an async fiber's stack, and every entry into Node
// from there must run on Node's stack, where V8 scans it during the
// collections the island's allocations cause.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { churn, delay, depth, get, Handler } from "server-kit";

class CountingHandler extends Handler {
  served = 0;
  async handle(path: string): Promise<string> {
    this.served++;
    return `${await super.handle(path)}#${this.served}`;
  }
}

const handler = new CountingHandler("kit");
const timers: string[] = [];

// Called from a continuation (a runtime job on Node's stack): its eager
// start runs on a fiber and calls into the island, deep, before its first
// await returns to the caller's frame on Node's stack.
async function listFiles(path: string, wait: (n: number) => Promise<number>): Promise<unknown> {
  const out: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      out.push(`${path}:${depth(300 + i)}`);
    }
    const more = await wait(out.length);
    out.push(String(more));
  } finally {
    out.push("done");
  }
  return out;
}

// Starts listFiles a few native frames deeper on the current stack.
function startDeep(levels: number, path: string): Promise<unknown> {
  const parts = [path, String(levels), path.length.toString(16)];
  if (levels > 0) return startDeep(levels - 1, parts[0]!);
  return listFiles(parts.join("").slice(0, path.length), (n) => delay(1, n));
}

async function respond(path: string): Promise<string> {
  const waited = await delay(1, path);
  const files = (await startDeep(24, waited)) as string[];
  let total = 0;
  for (let i = 0; i < 3; i++) {
    total += churn(i) > 0 ? 1 : 0;
    await delay(0);
  }
  const handled = await handler.handle(waited);
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      timers.push(path);
      resolve();
    }, 1),
  );
  return `${handled} churn=${total} files=${files.length}`;
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = req.url ?? "/";
  respond(path).then(
    (text) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(text);
    },
    (error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    },
  );
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  for (let i = 0; i < 40; i++) {
    const reply = await get(port, `/r${i}`);
    if (i % 10 === 0 || reply.status !== 200) console.log(reply.status, reply.body);
  }
  console.log("timers", timers.length, "served", handler.served, "count", handler.count);
  server.close(() => console.log("closed"));
}

void main();
