// node:http2 ALTSVC and ORIGIN on a TLS session (Node ignores ORIGIN on a
// cleartext one): the server session sends alt-svc metadata with a string
// origin and, from a request's stream, with a numeric stream id; it also
// sends an ORIGIN frame listing its origins, and the client hears 'altsvc'
// and 'origin'. The two ends race, so the recorded lines are sorted.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

const server = http2.createSecureServer({ key, cert });
server.on("session", (session) => {
  session.altsvc('h3=":443"', "https://example.com");
  session.origin("https://a.example", "https://b.example");
});
server.on("stream", (stream) => {
  stream.session.altsvc('h2=":8443"', stream.id);
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`https://localhost:${(server.address() as AddressInfo).port}`, {
    ca,
  });
  client.on("altsvc", (alt, origin, streamId) =>
    lines.push(`altsvc ${alt} ${origin} ${streamId === 0 ? "connection" : "stream"}`),
  );
  client.on("origin", (origins) => lines.push(`origin ${origins.sort().join(",")}`));
  client.on("connect", () => {
    const request = client.request({ ":path": "/" });
    request.resume();
    request.on("end", () => {
      setTimeout(() => {
        client.close(() => {
          server.close(() => {
            for (const line of lines.sort()) console.log(line);
          });
        });
      }, 100);
    });
    request.end();
  });
});
