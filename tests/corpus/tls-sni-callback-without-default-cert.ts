// tls.createServer with only an SNICallback: Node accepts options that
// carry no default cert/key pair, and every handshake is served from the
// context the callback answers. The callback is evaluated at its own
// position in the options literal, so a key entry written before it is
// read first.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const alt = tls.createSecureContext({
  cert: readFileSync(`${certs}/alt.pem`),
  key: readFileSync(`${certs}/alt-key.pem`),
});

const server = tls.createServer(
  {
    SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      console.log("sni", servername);
      cb(null, alt);
    },
  },
  (socket) => {
    socket.end("hello");
  },
);

const altKey = readFileSync(`${certs}/alt-key.pem`);
const ordered = tls.createServer(
  {
    key: (console.log("read key"), altKey),
    SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      console.log("read callback", servername);
      cb(null, alt);
    },
  },
  (socket) => {
    socket.end("ordered");
  },
);

function attempt(port: number, servername: string, next: () => void): void {
  let done = false;
  const finish = (line: string): void => {
    if (done) return;
    done = true;
    console.log(servername, line);
    next();
  };
  const socket = tls.connect({ port, host: "127.0.0.1", servername, ca }, () => {
    let text = "";
    socket.on("data", (data: Buffer) => {
      text += data.toString();
    });
    socket.on("end", () => finish(`authorized ${socket.authorized} ${text}`));
  });
  socket.on("error", (error: Error) => {
    finish(`error ${(error as NodeJS.ErrnoException).code}`);
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  attempt(port, "alt.localhost", () =>
    server.close(() => {
      console.log("closed");
      ordered.listen(0, "127.0.0.1", () => {
        const orderedPort = (ordered.address() as net.AddressInfo).port;
        attempt(orderedPort, "alt.localhost", () =>
          ordered.close(() => console.log("ordered closed")),
        );
      });
    }),
  );
});
