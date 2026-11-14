// A named typed options record reaching net.connect/createConnection and
// server.listen. The compiler hands the runtime the record's checked
// view, so the ladder reads the same properties Node's own reads would
// find, and an error renders the fields the source declared. Each case
// finishes before the next starts, and every server a case binds is
// closed before the next case runs.
import * as fs from "node:fs";
import * as net from "node:net";

interface Bind {
  port: number;
  host?: string;
}
interface MaybeBind {
  port?: number;
  host?: string;
}
interface OddBind {
  port?: number;
  host?: number;
}
interface ExtraBind {
  port?: number;
  host?: string;
  readableAll?: boolean;
  somethingElse?: string;
}
interface Conn {
  port: number;
  host: string;
  timeout?: number;
  family?: number;
}
interface MaybeConn {
  port?: number;
  host?: string;
}
interface OddConn {
  port: number;
  host: number;
}
interface SignalBind {
  port: number;
  host?: string;
  signal?: AbortSignal;
}
interface KeepAliveOpts {
  enable?: boolean;
  initialDelay?: number;
  interval?: any;
  count?: number;
}

class BindClass {
  port = 0;
  host = "127.0.0.1";
}

const steps: [string, (next: () => void) => void][] = [];

function step(name: string, fn: (next: () => void) => void): void {
  steps.push([name, fn]);
}

function run(index: number): void {
  if (index === steps.length) {
    console.log("done");
    return;
  }
  const next = () => run(index + 1);
  try {
    steps[index]![1](next);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(steps[index]![0], "threw", e.code, e.message);
    next();
  }
}

function attempt(name: string, fn: () => void): void {
  try {
    fn();
    console.log(name, "ok");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(name, e.code, e.message);
  }
}

function closeServer(server: net.Server, next: () => void): void {
  server.close(() => next());
}

// A record with the port declared; an absent host is every interface.
const anyHost: Bind = { port: 0 };
step("listen(record port)", (next) => {
  const server = net.createServer();
  const returned = server.listen(anyHost, () => {
    const bound = server.address() as net.AddressInfo;
    console.log("listen(record port)", typeof bound.port === "number" && bound.port > 0);
    console.log("listen(record port) returns the server", returned === server);
    closeServer(server, next);
  });
});

// A record with both fields: the host decides the bound address.
const loopback: Bind = { port: 0, host: "127.0.0.1" };
step("listen(record host)", (next) => {
  const server = net.createServer();
  server.listen(loopback, () => {
    const bound = server.address() as net.AddressInfo;
    console.log("listen(record host)", bound.address, bound.family);
    closeServer(server, next);
  });
});

// The error ladder, with the record's fields in the message.
step("listen(record bad port)", (next) => {
  const record: Bind = { port: 65536 };
  attempt("listen(record bad port)", () => {
    net.createServer().listen(record);
  });
  next();
});
step("listen(record no port)", (next) => {
  const record: MaybeBind = { host: "127.0.0.1" };
  attempt("listen(record no port)", () => {
    net.createServer().listen(record);
  });
  next();
});
step("listen(record host number)", (next) => {
  const record: OddBind = { port: 0, host: 5 };
  // Node's types spell host as a string; the runtime ladder still reads a
  // record holding a number (a JavaScript caller can).
  const bag: any = record;
  attempt("listen(record host number)", () => {
    net.createServer().listen(bag);
  });
  next();
});
step("listen(record empty)", (next) => {
  const record: MaybeBind = {};
  attempt("listen(record empty)", () => {
    net.createServer().listen(record);
  });
  next();
});

// Unknown properties of a typed record are ignored, as Node ignores them.
const extended: ExtraBind = {
  port: 0,
  host: "127.0.0.1",
  readableAll: true,
  somethingElse: "ignored",
};
step("listen(record extra)", (next) => {
  const server = net.createServer();
  server.listen(extended, () => {
    const bound = server.address() as net.AddressInfo;
    console.log("listen(record extra)", bound.address);
    closeServer(server, next);
  });
});

// A class instance is a bag too: its fields are the properties.
step("listen(class bag)", (next) => {
  const server = net.createServer();
  server.listen(new BindClass() as unknown as Bind, () => {
    const bound = server.address() as net.AddressInfo;
    console.log("listen(class bag)", bound.address);
    closeServer(server, next);
  });
});

// A record whose path is a pipe: address answers the path, before and
// after close, and a client's record dials it.
const pipePath = "/tmp/scriptc-net-typed-option-records.sock";
interface Pipe {
  path: string;
}
try {
  fs.unlinkSync(pipePath);
} catch {}
const pipeBind: Pipe = { path: pipePath };
step("listen(record path)", (next) => {
  const server = net.createServer();
  server.listen(pipeBind, () => {
    console.log("listen(record path)", server.listening);
    const pipeConnect: Pipe = { path: pipePath };
    const client = net.connect(pipeConnect);
    client.on("connect", () => {
      console.log("connect(record path) connected");
      client.destroy();
      server.close(() => {
        console.log("listen(record path) after close", server.listening);
        try {
          fs.unlinkSync(pipePath);
        } catch {}
        next();
      });
    });
    client.on("error", (err: Error) => {
      console.log("connect(record path) error", err.message);
      server.close(() => next());
    });
  });
});

// An already-listening server throws the catchable error, and the server
// keeps the binding it had.
step("listen(record again)", (next) => {
  const server = net.createServer();
  server.listen(anyHost, () => {
    attempt("listen(record again)", () => server.listen(loopback));
    console.log("listen(record again) still listening", server.listening);
    closeServer(server, next);
  });
});

// connect over a named record: the dial reaches a server this process
// listens on, and the record's timeout is accepted.
step("connect(record)", (next) => {
  const server = net.createServer();
  server.listen(anyHost, () => {
    const address = server.address() as net.AddressInfo;
    const conn: Conn = { port: address.port, host: "127.0.0.1", timeout: 5000 };
    const client = net.connect(conn);
    client.on("connect", () => {
      console.log("connect(record)", client.remoteAddress, client.remotePort === address.port);
      client.destroy();
      server.close(() => next());
    });
    client.on("error", (err: Error) => {
      console.log("connect(record) error", err.message);
      server.close(() => next());
    });
  });
});

// connect's errors from a record.
step("connect(record no port)", (next) => {
  const record: MaybeConn = {};
  const bag: any = record;
  attempt("connect(record no port)", () => {
    const socket = net.connect(bag);
    socket.on("error", () => {});
    socket.destroy();
  });
  next();
});
step("connect(record family)", (next) => {
  // A hostname (not an IP literal) makes the connect read and validate
  // options.family before any query runs.
  const record: Conn = { port: 1, host: "localhost", family: 5 };
  attempt("connect(record family)", () => {
    const socket = net.connect(record);
    socket.on("error", () => {});
    socket.destroy();
  });
  next();
});
step("connect(record bad host)", (next) => {
  const record: OddConn = { port: 1, host: 5 };
  const bag: any = record;
  attempt("connect(record bad host)", () => {
    const socket = net.connect(bag);
    socket.on("error", () => {});
    socket.destroy();
  });
  next();
});

// A record's signal reaches the connect: aborting it closes the socket.
step("connect(record signal)", (next) => {
  const controller = new AbortController();
  const record: SignalBind = { port: 1, host: "127.0.0.1", signal: controller.signal };
  const socket = net.connect(record);
  socket.on("error", () => {});
  socket.on("close", () => {
    console.log("connect(record signal) closed");
    next();
  });
  controller.abort();
});

// A live signal whose socket closes first: the close drops the abort
// registration, so the signal does not keep the socket alive (the
// sanitized lane's reference-count audit checks that).
step("connect(record live signal)", (next) => {
  const controller = new AbortController();
  const server = net.createServer();
  server.listen(anyHost, () => {
    const address = server.address() as net.AddressInfo;
    const record: SignalBind = {
      port: address.port,
      host: "127.0.0.1",
      signal: controller.signal,
    };
    const socket = net.connect(record);
    socket.on("error", () => {});
    socket.on("connect", () => {
      socket.destroy();
      server.close(() => {
        console.log("connect(record live signal)", controller.signal.aborted === false);
        next();
      });
    });
  });
});

// socket.setKeepAlive(options) over a named record: the runtime reads the
// record's fields, so a value whose ToNumber throws still throws.
step("setKeepAlive(record)", (next) => {
  const server = net.createServer();
  server.listen(anyHost, () => {
    const address = server.address() as net.AddressInfo;
    const socket = net.connect({ port: address.port, host: "127.0.0.1" });
    socket.on("error", () => {});
    socket.on("connect", () => {
      const record: KeepAliveOpts = {
        enable: true,
        initialDelay: 1000,
        interval: {
          valueOf(): number {
            throw new Error("interval conversion");
          },
        },
        count: 3,
      };
      try {
        socket.setKeepAlive(record);
        console.log("setKeepAlive(record) ok");
      } catch (err) {
        console.log("setKeepAlive(record) threw", (err as Error).message);
      }
      socket.destroy();
      server.close(() => next());
    });
  });
});

// createConnection reads the same record.
step("createConnection(record)", (next) => {
  const server = net.createServer();
  server.listen(anyHost, () => {
    const address = server.address() as net.AddressInfo;
    const conn: Conn = { port: address.port, host: "127.0.0.1" };
    const client = net.createConnection(conn);
    client.on("connect", () => {
      console.log("createConnection(record)", client.remotePort === address.port);
      client.destroy();
      server.close(() => next());
    });
    client.on("error", (err: Error) => {
      console.log("createConnection(record) error", err.message);
      server.close(() => next());
    });
  });
});

run(0);
