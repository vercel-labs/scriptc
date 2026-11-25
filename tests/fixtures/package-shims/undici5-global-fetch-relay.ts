// The GLOBAL fetch given a dispatcher of the undici package. Node's fetch
// is undici's, so the request leaves through the dispatcher: here a
// ProxyAgent whose proxy is a relay in this process that counts the
// tunnels it opens, then a class of the program that extends Dispatcher,
// then an Agent. The dispatcher is written in an init literal, and
// assigned to a record that is then handed to fetch as its init.
import * as http from "node:http";
import * as net from "node:net";
import { Agent, Dispatcher, ProxyAgent } from "undici";

// What a parcel query carries besides its address.
interface Query {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  dispatcher?: Dispatcher;
}

// Counts the requests it hands on.
class Tally extends Dispatcher {
  handed = 0;
  next: Dispatcher;
  constructor(next: Dispatcher) {
    super();
    this.next = next;
  }
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    this.handed += 1;
    return this.next.dispatch(options, handler);
  }
}

const depot = http.createServer((req, res) => {
  let parcel = "";
  req.on("data", (chunk: Buffer) => {
    parcel += chunk.toString();
  });
  req.on("end", () => {
    res.end(`${req.method} ${req.url} bay=${String(req.headers["x-bay"] ?? "none")} parcel=${JSON.stringify(parcel)}`);
  });
});

let tunnels = 0;
const relay = net.createServer((incoming) => {
  let request = "";
  let open = false;
  incoming.on("data", (chunk: Buffer) => {
    if (open) return;
    request += chunk.toString("latin1");
    if (!request.includes("\r\n\r\n")) return;
    open = true;
    tunnels += 1;
    const target = request.split("\r\n")[0]!.split(" ")[1]!;
    const onward = net.connect(Number(target.split(":")[1]), "127.0.0.1", () => {
      incoming.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      onward.pipe(incoming);
      incoming.pipe(onward);
    });
    onward.on("error", () => incoming.destroy());
    incoming.on("error", () => onward.destroy());
  });
  incoming.on("error", () => {});
});

function portOf(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function main(): Promise<void> {
  const base = `http://127.0.0.1:${await portOf(depot)}`;
  const viaRelay = new ProxyAgent(`http://127.0.0.1:${await portOf(relay)}`);
  const line = async (label: string, answer: Response): Promise<void> => {
    console.log(`${label} | ${answer.status} ${await answer.text()} | tunnels ${tunnels}`);
  };

  // Without a dispatcher the request goes straight to the depot.
  await line("straight", await fetch(`${base}/parcels/1`, { headers: { "x-bay": "A" } }));

  // The dispatcher written in the init.
  await line("in the init", await fetch(`${base}/parcels/2`, { dispatcher: viaRelay, headers: { "x-bay": "B" } } as RequestInit));
  await line(
    "in the init, with a body",
    await fetch(`${base}/parcels`, { method: "POST", body: "crate of pears", dispatcher: viaRelay } as RequestInit),
  );

  // The dispatcher assigned to a record, and the record handed over.
  const query: Query = { method: "PUT", body: "two crates" };
  query.dispatcher = viaRelay;
  await line("assigned", await fetch(`${base}/parcels/3`, query as RequestInit));
  const second: Query = { headers: { "x-bay": "C" } };
  second.dispatcher = viaRelay;
  await line("assigned again", await fetch(`${base}/parcels/4`, second as RequestInit));

  // A dispatcher of the program's own class.
  const tally = new Tally(viaRelay);
  const counted: Query = {};
  counted.dispatcher = tally;
  await line("own class", await fetch(`${base}/parcels/5`, counted as RequestInit));
  console.log(`handed on ${tally.handed}`);

  // An Agent opens no tunnel.
  const direct = new Agent();
  const before = tunnels;
  await line("agent", await fetch(`${base}/parcels/6`, { dispatcher: direct, headers: { "x-bay": "D" } } as RequestInit));
  console.log(`agent used the relay: ${tunnels !== before}`);
  await direct.close();

  // A record whose dispatcher was never set, and one set to undefined.
  const unset: Query = { method: "DELETE" };
  await line("never set", await fetch(`${base}/parcels/7`, unset as RequestInit));
  await line("undefined", await fetch(`${base}/parcels/8`, { dispatcher: undefined } as RequestInit));

  await viaRelay.close();
  relay.close();
  depot.close();
}

void main();
