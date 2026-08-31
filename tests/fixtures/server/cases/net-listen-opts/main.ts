/* The portless listenOnProxyInterface shape: listen({ port, host,
 * ipv6Only, reusePort }[, cb]) — the explicit v4/v6 listener PAIR on one port
 * (getProxyBindTargets' loopback targets), each family answered by its
 * own server, plus the EADDRINUSE arm (same host, same port) and the
 * host that exists on no interface. Ephemeral ports never print; the
 * EADDRINUSE message compares by prefix (net-port-check's rule). */
import * as net from "node:net";

const v4 = net.createServer((socket) => socket.end("v4\n"));
const v6 = net.createServer((socket) => socket.end("v6\n"));

type ProxyBindTarget = { host: string; ipv6Only?: boolean; reusePort?: boolean };

/* portless's listenOnProxyInterface, verbatim shapes: the target record
 * (ipv6Only and reusePort optional — `boolean | undefined` flows into the option) and
 * the OPTIONAL listener binding (`(() => void) | undefined`). */
function listenOnProxyInterface(
  server: net.Server,
  port: number,
  target: ProxyBindTarget,
  listener?: () => void
): void {
  const reusePort = target.reusePort;
  server.listen({
    port,
    host: target.host,
    ipv6Only: target.ipv6Only,
    reusePort: reusePort,
  }, listener);
}

/* A concrete boolean shorthand keeps the static option-record path honest:
 * optional bindings use the spelled-out initializer above, while a narrowed
 * boolean may use Node's shorthand spelling. */
function listenWithReusePortShorthand(
  server: net.Server,
  port: number,
  host: string,
  reusePort: boolean,
): void {
  server.listen({ port, host, reusePort });
}

function readFrom(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    socket.once("end", () => resolve(body.trim()));
    socket.once("error", (err) => resolve(`error ${err.message.split(" ")[1] ?? ""}`));
  });
}

async function main(port: number): Promise<void> {
  console.log("v4 answers:", await readFrom("127.0.0.1", port));
  console.log("v6 answers:", await readFrom("::1", port));

  // The same host+port again: the async EADDRINUSE 'error'.
  const clash = net.createServer();
  clash.on("error", (err) => {
    if (err.message.startsWith("listen EADDRINUSE: address already in use 127.0.0.1:")) {
      console.log("clash: in use");
    } else {
      console.log(`clash unexpected: ${err.message}`);
    }
    v4.close();
    v6.close(() => console.log("done"));
  });
  // The OMITTED-listener call — the undefined arm of the optional
  // callback flows through listenOnProxyInterface's pass-through.
  listenWithReusePortShorthand(clash, port, "127.0.0.1", false);
}

listenOnProxyInterface(v4, 0, { host: "127.0.0.1" }, () => {
  const port = v4.address().port;
  // The undefined-listener arm: no callback, wait for 'listening'-free
  // readiness by probing v6 after a turn via the v4 callback's sibling.
  listenOnProxyInterface(v6, port, { host: "::1", ipv6Only: true }, () => {
    main(port);
  });
});
