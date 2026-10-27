// @stderr
// The hot-shots StatsD client (its JavaScript, vendored at 8.5.0) sends
// metrics over UDP to a local dgram server, which prints every datagram in
// arrival order: tags and explicit sample rates, the callback, child
// clients, the error handler, close, and a send after close. Its mock and
// Unix-socket modes format and refuse without the network.
import * as dgram from "node:dgram";
import { StatsD } from "hot-shots";

const server = dgram.createSocket("udp4");
const received: string[] = [];
let expected = 0;
let arrived: () => void = () => {};

server.on("message", (msg) => {
  received.push(msg.toString());
  if (received.length === expected) arrived();
});

function datagrams(count: number): Promise<void> {
  expected += count;
  return new Promise((resolve) => {
    arrived = resolve;
    if (received.length >= expected) resolve();
  });
}

function flush(): void {
  for (const line of received.splice(0)) console.log(line);
  expected = 0;
}

async function udp(port: number): Promise<void> {
  const client = new StatsD({
    host: "127.0.0.1",
    port,
    prefix: "app.",
    globalTags: { service: "svc", env: "test" },
    errorHandler: (err) => console.log("error handler", (err as Error & { code?: string }).code),
  });
  client.increment("boot");
  client.increment("requests", 3, ["route:/a"]);
  client.increment("poll", 1, { result: "none", env: "prod" });
  client.decrement("inflight");
  client.decrement("slots", 2, 1, ["pool:a"]);
  client.gauge("queue.depth", 12, 1, { queue: "builds" });
  client.timing("startup", 250);
  client.timing("phase", 12.5, ["phase:load"]);
  client.histogram("payload.bytes", 1024, ["kind:json"]);
  client.distribution("latency", 42.5, 1, { op: "read" });
  client.distribution("memory", 1048576, { node: "v24" });
  client.distribution("polltime", 17);
  client.set("users", "alice");
  client.increment(["a.multi", "b.multi"], 2);
  await datagrams(15);
  flush();

  await new Promise<void>((resolve) => {
    client.increment("acked", 1, (err: unknown, bytes: unknown) => {
      console.log("sent", err, bytes);
      resolve();
    });
  });
  await datagrams(1);
  flush();

  const child = client.childClient({ prefix: "child.", globalTags: { component: "c" } });
  child.increment("hit");
  child.distribution("size", 3, { env: "dev" });
  await datagrams(2);
  flush();

  await new Promise<void>((resolve) => {
    client.close((err) => {
      console.log("closed", err);
      resolve();
    });
  });
  client.increment("after.close");
}

function offline(): void {
  process.env.DD_ENTITY_ID = "pod|7";
  const mock = new StatsD({ mock: true, prefix: "m.", globalTags: ["a:b"] });
  mock.increment("hits", 2);
  mock.timing("t", 5, ["x:y"]);
  mock.check("svc", mock.CHECKS.OK, { hostname: "h", message: "fine" });
  mock.event("title", "text\nmore", { priority: "low" }, ["e:1"]);
  console.log(mock.mockBuffer);
  const errors: string[] = [];
  const uds = new StatsD({ protocol: "uds", errorHandler: (e) => errors.push(e.message) });
  uds.increment("x");
  console.log(errors);
}

server.bind(0, "127.0.0.1", () => {
  void udp(server.address().port).then(() => {
    offline();
    server.close(() => console.log("server closed"));
  });
});
