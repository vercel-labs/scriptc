// node:http2 ALTSVC and ORIGIN on a TLS session (Node ignores ORIGIN on a
// cleartext one): the server session sends alt-svc metadata with a string
// origin and, from a request's stream, with a numeric stream id; it also
// sends an ORIGIN frame listing its origins, and the client hears 'altsvc'
// and 'origin'. String origins canonicalize to their URL origin (path and
// default port drop, the host lowercases) and an unparsable one throws.
// The two ends race, so the recorded lines are sorted.
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
    session.altsvc('h3=":443"', "https://Example.COM:443/some/path?q=1");
    session.origin("https://A.Example:443/x", "http://b.example:80/y");
    const errors: [string, () => void][] = [
      ["bad-url", () => session.altsvc('h2=":8443"', "not a url")],
      ["zero-stream", () => session.altsvc('h2=":8443"', 0)],
      ["bad-origin", () => session.origin("not a url")],
    ];
    for (const [label, run] of errors) {
      try {
        run();
        lines.push(`${label} no-throw`);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException;
        lines.push(`${label} ${failure.code} ${failure.message}`);
      }
    }
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
            server.close(() => resolve());
          });
        }, 100);
      });
      request.end();
    });
  });
});

// A cleartext session still carries ALTSVC, but the ORIGIN frame it sends
// never reaches the client's listeners.
await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("session", (session) => {
    session.origin("https://cleartext.example");
    session.altsvc('h3=":443"', "https://cleartext.example");
  });
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("altsvc", (alt, origin, streamId) =>
      lines.push(`clear altsvc ${alt} ${origin} ${streamId === 0 ? "connection" : "stream"}`),
    );
    client.on("origin", (origins) => lines.push(`clear origin ${origins.sort().join(",")}`));
    const request = client.request({ ":path": "/" });
    request.resume();
    request.on("end", () => {
      setTimeout(() => {
        client.close(() => {
          server.close(() => resolve());
        });
      }, 100);
    });
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
