// http.Agent's maxTotalSockets: the agent dials at most that many sockets
// across every origin, so a request that finds no slot queues — even when
// its own origin is far below maxSockets — and starts when a socket leaves
// the agent, which is Node's Agent.removeSocket: the freed origin's queue
// first, then the oldest queued origin. Responses are released explicitly
// so the sequencing is not a race.
import * as http from "node:http";
import * as net from "node:net";

interface Origin {
  server: http.Server;
  arrived(path: string): Promise<void>;
  release(path: string): void;
}

function origin(label: string): Origin {
  const pending = new Map<string, () => void>();
  const waiters = new Map<string, () => void>();
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    console.log(label, "arrived", path);
    pending.set(path, () => res.end(`ok:${path}`));
    const waiter = waiters.get(path);
    if (waiter !== undefined) {
      waiters.delete(path);
      waiter();
    }
  });
  return {
    server,
    arrived(path: string): Promise<void> {
      if (pending.has(path)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.set(path, resolve);
      });
    },
    release(path: string): void {
      const release = pending.get(path);
      if (release === undefined) throw new Error(`${path} has not arrived`);
      release();
    },
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function errText(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return `${e.code} ${e.message}`;
}

function probe(label: string, make: () => http.Agent): void {
  try {
    const built = make();
    console.log(label, "->", built.maxSockets, built.maxTotalSockets, built.maxFreeSockets, built.keepAliveMsecs);
  } catch (err) {
    console.log(label, "throw", errText(err));
  }
}

function request(agent: http.Agent, port: number, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => {
        console.log("body", path, text);
        resolve(text);
      });
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const agent = new http.Agent({ maxSockets: 4, maxTotalSockets: 1 });
  console.log("defaults", agent.maxSockets, agent.maxTotalSockets, new http.Agent().maxTotalSockets);

  /* maxTotalSockets goes through Node's validateNumber(..., 1); the other
   * agent options keep Node's `||` default, so a zero falls back. */
  probe("total zero", () => new http.Agent({ maxTotalSockets: 0 }));
  probe("total negative", () => new http.Agent({ maxTotalSockets: -1 }));
  probe("total fraction", () => new http.Agent({ maxTotalSockets: 0.5 }));
  probe("total one and a half", () => new http.Agent({ maxTotalSockets: 1.5 }));
  probe("options zero", () => new http.Agent({ maxSockets: 0, maxFreeSockets: 0, keepAliveMsecs: 0 }));

  /* One origin, two requests: the second queues on the total even though
   * the origin sits at one of its four sockets. */
  const first = origin("a");
  const port = await listen(first.server);
  const one = request(agent, port, "/one");
  await first.arrived("/one");
  console.log("total one", agent.totalSocketCount);
  const two = request(agent, port, "/two");
  console.log("total queued", agent.totalSocketCount);
  first.release("/one");
  await one;
  await first.arrived("/two");
  console.log("total second dialed", agent.totalSocketCount);
  first.release("/two");
  await two;

  /* Two origins: the request queued behind the total starts when the other
   * origin's socket leaves the agent. */
  const other = origin("b");
  const otherPort = await listen(other.server);
  const three = request(agent, port, "/three");
  await first.arrived("/three");
  const four = request(agent, otherPort, "/four");
  console.log("total other queued", agent.totalSocketCount);
  first.release("/three");
  await three;
  await other.arrived("/four");
  console.log("total other dialed", agent.totalSocketCount);
  other.release("/four");
  await four;

  first.server.close();
  other.server.close();
  agent.destroy();
}

void main();
