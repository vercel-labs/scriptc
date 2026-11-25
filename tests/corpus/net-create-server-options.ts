// net.createServer(options[, listener]): the ServerOpts record applied to
// every accepted socket — allowHalfOpen (the peer's FIN leaves the write
// half open), highWaterMark (both stream highs), and the accepted
// noDelay/keepAlive settings. pauseOnConnect starts the socket paused, so
// its data waits for resume(). Printed relationships only, so both lanes
// agree.
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
  const server = net.createServer(
    {
      allowHalfOpen: true,
      highWaterMark: 1024,
      noDelay: true,
      keepAlive: true,
      keepAliveInitialDelay: 1000,
    },
    (socket) => {
      // the stream highs are stream.Duplex members @types/node exposes;
      // this surface answers them through the socket's dynamic reads
      const dyn = socket as any;
      say("accepted", socket.allowHalfOpen, dyn.readableHighWaterMark, dyn.writableHighWaterMark);
      socket.on("data", () => {});
      socket.on("error", () => {});
      socket.on("end", () => {
        socket.write("after-fin", (err) => {
          say("write-after-fin", err === null || err === undefined ? "ok" : String((err as { code?: string }).code));
          socket.destroy();
          server.close(() => run());
        });
      });
    },
  );
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const client = net.connect(port, "127.0.0.1");
    client.on("connect", () => client.end("x"));
    client.on("data", () => {});
    client.on("error", () => {});
  });
});

steps.push(() => {
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    const chunks: string[] = [];
    socket.on("data", (chunk) => chunks.push(String(chunk)));
    socket.on("error", () => {});
    setTimeout(() => {
      say("before-resume", JSON.stringify(chunks.join("")));
      socket.resume();
      setTimeout(() => {
        say("after-resume", JSON.stringify(chunks.join("")));
        socket.destroy();
        server.close(() => run());
      }, 100);
    }, 150);
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const client = net.connect(port, "127.0.0.1");
    client.on("connect", () => client.write("early"));
    client.on("error", () => {});
  });
});

run();
