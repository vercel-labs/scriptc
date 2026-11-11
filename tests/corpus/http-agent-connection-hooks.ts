// http.Agent's connection hooks: createConnection is net.createConnection
// over the same argument normalization (an options record dialing host:port
// or the Unix `path`, a positional port with an optional host, a path
// string, the trailing listener as the socket's 'connect' callback) and the
// same validation ladder (ERR_MISSING_ARGS, the options.port type check that
// a non-record argument reaches, ERR_SOCKET_BAD_PORT for a number and for a
// numeric string, the msecs timeout check); keepSocketAlive/reuseSocket are
// the documented base implementations.
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = new http.Agent();
const sock = join(tmpdir(), `scriptc-agent-hooks-${process.pid}.sock`);
const shown = (text: string): string => text.split(sock).join("<sock>");

function errText(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return `${e.code} ${e.message}`;
}

function show(label: string, fn: () => net.Socket): void {
  try {
    const value = fn();
    console.log(label, "->", "socket");
    value.destroy();
  } catch (err) {
    console.log(label, "throw", shown(errText(err)));
  }
}

// One request over a socket createConnection returned, so the callback's
// placement and the socket's readability are both exercised.
function exchange(
  label: string,
  make: (onConnect: () => void) => net.Socket,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let text = "";
    const socket = make(() => {
      socket.write(`GET /${label} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    console.log(label, "returns", "socket");
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => {
      console.log(label, text.split("\r\n")[0], text.endsWith(`ok:/${label}`));
      socket.destroy();
      resolve();
    });
    socket.on("error", (err: Error) => {
      console.log(label, "error", shown(errText(err)));
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log("maxTotalSockets", agent.maxTotalSockets, new http.Agent().maxSockets);
  agent.maxSockets = 2;
  console.log("maxSockets set", agent.maxSockets);

  show("no options", () => agent.createConnection(undefined as unknown as http.AgentOptions));
  show("empty options", () => agent.createConnection({}));
  show("null options", () => agent.createConnection(null as unknown as http.AgentOptions));
  show("boolean options", () => agent.createConnection(false as unknown as http.AgentOptions));
  show("port huge", () => agent.createConnection({ port: 70000 }));
  show("port fractional", () => agent.createConnection({ port: 80.5 }));
  // The positional forms: a numeric string still reads as a port (and the
  // port check reports its type), while a non-numeric string is a socket
  // path and takes the path arm below.
  show("positional huge", () => agent.createConnection(70000));
  show("positional negative", () => agent.createConnection(-1));
  show("positional numeric string", () => agent.createConnection("70000"));
  show("positional empty string", () => agent.createConnection(""));
  show("timeout negative", () => agent.createConnection({ port: 80, timeout: -1 }));

  const server = http.createServer((req, res) => {
    res.end(`ok:${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  await exchange("object", (onConnect) =>
    agent.createConnection({ port, host: "127.0.0.1" }, () => onConnect()),
  );
  await exchange("positional", (onConnect) => agent.createConnection(port, () => onConnect()));

  // keepSocketAlive/reuseSocket on a connected socket: Node's base methods
  // set keep-alive/unref and ref/reusedSocket respectively.
  await new Promise<void>((resolve) => {
    const socket = agent.createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      const request = {} as { reusedSocket?: boolean };
      console.log("keepSocketAlive", agent.keepSocketAlive(socket));
      agent.reuseSocket(socket, request as unknown as http.ClientRequest);
      console.log("request.reusedSocket", request.reusedSocket);
      socket.destroy();
      resolve();
    });
    socket.on("error", (err: Error) => {
      console.log("hook socket error", errText(err));
      resolve();
    });
  });

  // The path form dials a Unix socket; a name with no socket behind it
  // fails with ENOENT at connect time, never in the call.
  const unix = http.createServer((req, res) => {
    res.end(`ok:${req.url}`);
  });
  await new Promise<void>((resolve) => unix.listen(sock, resolve));
  await exchange("path", (onConnect) => agent.createConnection(sock, () => onConnect()));
  await new Promise<void>((resolve) => unix.close(() => resolve()));

  await new Promise<void>((resolve) => {
    const missing = agent.createConnection(join(tmpdir(), "scriptc-no-such-agent.sock"));
    missing.on("error", (err: Error) => {
      console.log("missing path error", (err as NodeJS.ErrnoException).code);
      resolve();
    });
  });

  server.close();
  agent.destroy();
}

void main();
