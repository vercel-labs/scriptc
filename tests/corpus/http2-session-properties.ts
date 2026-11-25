// node:http2 session and server properties: a TLS session reports encrypted
// true and the negotiated ALPN "h2", an h2c session reports both undefined,
// a compatibility response's sendDate drops the implicit date header, and a
// server closes through Symbol.asyncDispose.
import * as http2 from "node:http2";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");
const describe = (name: string, session: http2.ClientHttp2Session): void => {
  lines.push(
    `${name} encrypted ${String(session.encrypted)} alpn ${String(session.alpnProtocol)}`,
  );
};

const secure = http2.createSecureServer({ key, cert });
secure.on("session", (session) => {
  lines.push(`secure server session encrypted ${String(session.encrypted)}`);
  lines.push(`secure server session alpn ${String(session.alpnProtocol)}`);
});
secure.on("request", (req, res) => {
  res.sendDate = false;
  res.writeHead(200);
  res.end("secure body");
});
secure.listen(0, () => {
  const client = http2.connect(`https://localhost:${(secure.address() as AddressInfo).port}`, {
    ca,
  });
  client.on("connect", () => {
    describe("secure client", client);
    const request = client.request({ ":path": "/" });
    request.on("response", (headers) => {
      lines.push(`secure response date ${String("date" in headers)}`);
    });
    request.resume();
    request.on("end", () => client.close());
    request.end();
  });
  client.on("close", () => {
    secure.close(() => {
      const plain = http2.createServer();
      plain.on("request", (req, res) => {
        res.end("plain body");
      });
      plain.listen(0, "127.0.0.1", () => {
        const h2c = http2.connect(`http://127.0.0.1:${(plain.address() as AddressInfo).port}`);
        h2c.on("connect", () => {
          describe("h2c client", h2c);
          const request = h2c.request({ ":path": "/" });
          request.resume();
          request.on("end", () => h2c.close());
          request.end();
        });
        h2c.on("close", () => {
          void (async () => {
            await plain[Symbol.asyncDispose]();
            lines.push("plain disposed");
            for (const line of lines.sort()) console.log(line);
            process.exit(0);
          })();
        });
      });
    });
  });
});
