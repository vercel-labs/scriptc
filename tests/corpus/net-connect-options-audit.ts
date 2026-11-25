// net.connect / net.createConnection / socket.connect options: the
// address facts of a connected options-form dial, the timeout and abort
// signals, the dial's blockList filter, and Node's port ladder. Prints
// deterministic relationships only (never an ephemeral port number).
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);

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

const server = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
let port = 0;

/* One options-form dial: `factory` builds the client, `after` prints the
 * connected socket's facts, and the probe settles on the client's close. */
const dial = (label: string, factory: () => net.Socket, after: (client: net.Socket) => void): void => {
  let client: net.Socket;
  try {
    client = factory();
  } catch (err) {
    say(label, "throw", codeOf(err), messageOf(err));
    run();
    return;
  }
  let settled = false;
  const settle = (tag: string, detail: string): void => {
    if (settled) return;
    settled = true;
    say(label, tag, detail);
    client.destroy();
    run();
  };
  client.on("connect", () => {
    if (settled) return;
    after(client);
    settle("connected", "");
  });
  client.on("error", (err) => settle("error", codeOf(err)));
  client.on("close", () => settle("closed", ""));
};

steps.push(() => {
  let connectingAtCreation = false;
  dial(
    "connect-options",
    () => {
      const client = net.connect({ port, host: "127.0.0.1" });
      connectingAtCreation = client.connecting;
      return client;
    },
    (client) => {
      say(
        "connect-options",
        "connecting-at-creation",
        connectingAtCreation,
        "local",
        client.localAddress,
        typeof client.localPort === "number" && client.localPort > 0,
        "remote-port",
        client.remotePort === port,
      );
    },
  );
});

steps.push(() => {
  dial(
    "connect-local-address",
    () => net.connect({ port, host: "127.0.0.1", localAddress: "127.0.0.1" }),
    (client) => {
      say("connect-local-address", "local", client.localAddress, typeof client.localPort === "number" && client.localPort > 0);
    },
  );
});

steps.push(() => {
  dial(
    "connect-family",
    () => net.connect({ port, host: "127.0.0.1", family: 4 }),
    (client) => {
      say("connect-family", "remote", client.remoteAddress, client.remotePort === port);
    },
  );
});

steps.push(() => {
  dial(
    "createConnection-options",
    () => net.createConnection({ port, host: "127.0.0.1" }),
    (client) => {
      say("createConnection-options", "remote", client.remotePort === port);
    },
  );
});

steps.push(() => {
  const client = new net.Socket();
  say("socket-connect-options", "connecting", client.connecting === true);
  client.on("connect", () => {
    say("socket-connect-options", "connected", client.connecting === false, client.remotePort === port);
    client.destroy();
    run();
  });
  client.on("error", (err) => {
    say("socket-connect-options", "error", codeOf(err));
    run();
  });
  client.connect(port, "127.0.0.1");
});

steps.push(() => {
  const client = net.connect({ port, host: "127.0.0.1", timeout: 80 });
  let timedOut = false;
  let settled = false;
  const settle = (tag: string): void => {
    if (settled) return;
    settled = true;
    say("connect-timeout", tag, timedOut);
    client.destroy();
    run();
  };
  client.on("timeout", () => {
    timedOut = true;
  });
  client.on("error", (err) => settle(`error-${codeOf(err)}`));
  client.on("close", () => settle("closed"));
  setTimeout(() => settle("settled"), 300);
});

steps.push(() => {
  const controller = new AbortController();
  controller.abort();
  const client = net.connect({ port, host: "127.0.0.1", signal: controller.signal });
  let settled = false;
  const settle = (tag: string): void => {
    if (settled) return;
    settled = true;
    say("connect-aborted-signal", tag);
    client.destroy();
    run();
  };
  client.on("error", (err) => settle(`error-${codeOf(err)}`));
  client.on("close", () => settle("closed"));
  setTimeout(() => settle("timeout"), 300);
});

steps.push(() => {
  const list = new net.BlockList();
  list.addAddress("127.0.0.1", "ipv4");
  const client = net.connect({ port, host: "127.0.0.1", blockList: list });
  let settled = false;
  const settle = (tag: string): void => {
    if (settled) return;
    settled = true;
    say("connect-block-list", tag);
    client.destroy();
    run();
  };
  client.on("error", (err) => settle(`error-${codeOf(err)}`));
  client.on("close", () => settle("closed"));
  setTimeout(() => settle("timeout"), 300);
});

steps.push(() => {
  // a port outside Node's range throws its validatePort RangeError before
  // any dial starts (a non-number port is a TypeScript error here)
  try {
    net.connect({ port: -1, host: "127.0.0.1" });
    say("connect-port", "accepted");
  } catch (err) {
    say("connect-port", codeOf(err), messageOf(err));
  }
  run();
});

server.listen(0, "127.0.0.1", () => {
  port = (server.address() as { port: number }).port;
  say("server", "listening");
  run();
});
steps.push(() => {
  server.close(() => {
    say("server", "closed");
    run();
  });
});
