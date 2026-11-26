// net.createServer({ blockList }): a connection from a blocked address is
// dropped before any 'connection' listener or connection handler runs; an
// empty list lets the connection through as usual.
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
type Step = () => void;
const steps: Step[] = [];
const run = (): void => {
  const step = steps.shift();
  if (step === undefined) {
    console.log(out.join("\n"));
    return;
  }
  step();
};

steps.push(() => {
  const list = new net.BlockList();
  list.addAddress("127.0.0.1", "ipv4");
  const server = net.createServer({ blockList: list }, (socket) => {
    say("blocked-handler", "called");
    socket.destroy();
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const client = net.connect(port, "127.0.0.1");
    client.on("connect", () => say("blocked-client", "connected"));
    client.on("error", (err) => say("blocked-client", "error", String((err as { code?: string }).code)));
    client.on("close", () => {
      say("blocked-connections", connections);
      server.close(() => run());
    });
  });
});

steps.push(() => {
  const server = net.createServer({ blockList: new net.BlockList() }, (socket) => {
    say("allowed-handler", "called");
    socket.destroy();
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const client = net.connect(port, "127.0.0.1");
    client.on("error", () => {});
    client.on("close", () => {
      say("allowed-connections", connections);
      server.close(() => run());
    });
  });
});

steps.push(() => {
  // a getter-backed blockList reads the way Node's property access does:
  // the accessor runs and the inbound connection is blocked
  const list = new net.BlockList();
  list.addAddress("127.0.0.1", "ipv4");
  let reads = 0;
  const options = {
    get blockList() {
      reads += 1;
      return list;
    },
  };
  const server = net.createServer(options, (socket) => {
    say("getter-handler", "called");
    socket.destroy();
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const client = net.connect(port, "127.0.0.1");
    client.on("error", () => {});
    client.on("close", () => {
      say("getter-blocked-connections", connections, "reads", reads);
      server.close(() => run());
    });
  });
});

run();
