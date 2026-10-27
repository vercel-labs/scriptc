// The hot-shots StatsD client (compiled from scriptc's built-in shim) in
// buffered mode: metrics join one datagram until maxBufferSize, close
// flushes the rest, child clients share the buffer. Also explicit sample
// rates of 1, the telegraf line format, stat arrays with a callback, and
// suffixes.
import * as dgram from "node:dgram";
import { StatsD } from "hot-shots";

const server = dgram.createSocket("udp4");
const received: string[] = [];
let waiting: (() => void) | null = null;
let want = 0;
server.on("message", (msg) => {
  received.push(msg.toString());
  if (waiting !== null && received.length >= want) {
    const done = waiting;
    waiting = null;
    done();
  }
});

function datagrams(count: number): Promise<void> {
  want = count;
  return new Promise((resolve) => {
    if (received.length >= want) resolve();
    else waiting = resolve;
  });
}

function flush(label: string): void {
  console.log("--", label);
  for (const line of received.splice(0)) console.log(JSON.stringify(line));
}

async function run(port: number): Promise<void> {
  const buffered = new StatsD({
    host: "127.0.0.1",
    port,
    maxBufferSize: 64,
    bufferFlushInterval: 60000,
    suffix: ".s",
    globalTags: ["team:core"],
  });
  buffered.increment("one");
  buffered.increment("two", 2);
  buffered.gauge("three", 3);
  buffered.histogram("four", 4, ["h:1"]);
  const child = buffered.childClient({ prefix: "kid.", suffix: ".x" });
  child.increment("five");
  await new Promise<void>((resolve) => buffered.close(() => resolve()));
  await datagrams(2);
  flush("buffered");

  const telegraf = new StatsD({ host: "127.0.0.1", port, telegraf: true, globalTags: { region: "eu" } });
  telegraf.increment("hits", 1, 1, { route: "/x" });
  telegraf.timing("lat", 7, ["kind:a"]);
  await datagrams(2);
  flush("telegraf");

  const plain = new StatsD({ host: "127.0.0.1", port, prefix: "p." });
  await new Promise<void>((resolve) => {
    plain.increment(["a", "b", "c"], 1, 1, ["t:1"], (err: unknown, bytes: unknown) => {
      console.log("array sent", err, bytes);
      resolve();
    });
  });
  plain.set("users", 42, 1);
  plain.unique("visitors", "v1");
  plain.decrement("down", 3, ["d:1"]);
  plain.decrement("gone");
  await datagrams(7);
  flush("plain");
  await new Promise<void>((resolve) => {
    telegraf.close(() => plain.close(() => resolve()));
  });
}

server.bind(0, "127.0.0.1", () => {
  void run(server.address().port).then(() => server.close(() => console.log("server closed")));
});
