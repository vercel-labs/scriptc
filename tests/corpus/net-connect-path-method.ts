// socket.connect(path[, connectListener]): an idle net.Socket dials a Unix
// socket path — Node's Socket.prototype.connect path form — and answers the
// socket for chaining. The connect listener runs on 'connect'.
import * as net from "node:net";
import { unlinkSync } from "node:fs";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

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

const path = `net-connect-method-${process.pid}.sock`;
const server = net.createServer((socket) => {
  socket.on("data", () => socket.end("ok"));
  socket.on("error", () => {});
});

steps.push(() => {
  const client = new net.Socket();
  client.on("connect", () => {
    say("connect-path", "connected", typeof client.remoteAddress);
  });
  client.on("data", (chunk) => {
    say("connect-path", "data", String(chunk));
    client.destroy();
    run();
  });
  client.on("error", (err) => {
    say("connect-path", "error", codeOf(err));
    run();
  });
  say("connect-path", "chains", client.connect(path) === client);
  client.write("hello");
});

steps.push(() => {
  const client = new net.Socket();
  client.on("error", (err) => {
    say("connect-path-cb", "error", codeOf(err));
    run();
  });
  client.on("data", () => {});
  client.connect(path, () => {
    say("connect-path-cb", "called");
    setTimeout(() => {
      client.destroy();
      server.close(() => {
        try {
          unlinkSync(path);
        } catch {}
        say("server", "closed");
        run();
      });
    }, 100);
  });
});

server.listen(path, () => {
  say("server", "listening");
  run();
});
