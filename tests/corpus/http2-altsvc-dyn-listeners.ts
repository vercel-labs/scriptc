// Dynamically registered (checked-dynamic) session listeners receive every
// ALTSVC and ORIGIN frame its peer sends: the boxes handed to the listener
// own their strings, so nothing outlives the callbacks and a session closed
// after many frames keeps none of them.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

await new Promise<void>((resolve) => {
  const server = http2.createSecureServer({ key, cert });
  server.on("session", (session) => {
    for (let i = 0; i < 24; i++) {
      session.altsvc('h2=":8443"', `https://alt${i}.example`);
      session.origin(`https://origin${i}.example`);
    }
  });
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`https://localhost:${(server.address() as AddressInfo).port}`, {
      ca,
    });
    const session: any = client;
    let altsvc = 0;
    let origin = 0;
    session.on("altsvc", (alt: string) => {
      altsvc += alt.length > 0 ? 1 : 0;
    });
    session.on("origin", (origins: string[]) => {
      origin += origins.length;
    });
    const request = client.request({ ":path": "/" });
    request.resume();
    request.on("end", () => {
      setTimeout(() => {
        client.close(() => {
          server.close(() => {
            lines.push(`altsvc ${altsvc}`, `origin ${origin}`);
            resolve();
          });
        });
      }, 100);
    });
    request.end();
  });
});

for (const line of lines) console.log(line);
