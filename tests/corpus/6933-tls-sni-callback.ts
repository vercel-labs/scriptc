// tls.createServer with an SNICallback: the callback receives each
// ClientHello's servername and answers a SecureContext synchronously or
// later, or none, so the default cert/key pair serves; an error answer
// fails that handshake. Clients that trust the CA see the certificate the
// answer chose: alt.localhost verifies only with the alt context, and a
// name served the default localhost pair fails Node's hostname check.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const altContext = tls.createSecureContext({
  cert: readFileSync(`${certs}/alt.pem`),
  key: readFileSync(`${certs}/alt-key.pem`),
});

const server = tls.createServer(
  {
    cert,
    key,
    SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      console.log("sni", servername);
      if (servername === "alt.localhost") setTimeout(() => cb(null, altContext), 5);
      else if (servername === "fail.localhost") cb(new Error(`no certificate for ${servername}`));
      else cb(null, undefined);
    },
  },
  (socket) => {
    socket.end("hello");
  },
);

// The callback is read where it appears, effects included: a later cert
// initializer that reassigns its binding does not change the callback the
// server uses.
type Sni = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
let chosen: Sni = (servername, cb) => {
  console.log("first callback", servername);
  cb(null, altContext);
};
const ordered = tls.createServer(
  {
    SNICallback: (console.log("read callback"), chosen),
    cert: (console.log("read cert"),
    (chosen = (servername, cb) => {
      console.log("second callback", servername);
      cb(null, undefined);
    }),
    cert),
    key,
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
  attempt(port, "localhost", () =>
    attempt(port, "alt.localhost", () =>
      attempt(port, "other.localhost", () =>
        attempt(port, "fail.localhost", () =>
          server.close(() => {
            console.log("closed");
            ordered.listen(0, "127.0.0.1", () => {
              const orderedPort = (ordered.address() as net.AddressInfo).port;
              attempt(orderedPort, "alt.localhost", () => ordered.close(() => console.log("ordered closed")));
            });
          }),
        ),
      ),
    ),
  );
});
