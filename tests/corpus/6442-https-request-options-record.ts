// https.request with options read at run time: a RequestOptions value
// spread with the CA, over TCP and over a Unix socket, an unverifiable
// certificate with and without rejectUnauthorized, and the protocol check.
import * as https from "node:https";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const sock = join(tmpdir(), `scriptc-https-${process.pid}.sock`);

const server = https.createServer(
  {
    cert: readFileSync("tests/fixtures/server/certs/localhost.pem"),
    key: readFileSync("tests/fixtures/server/certs/localhost-key.pem"),
  },
  (req, res) => res.end(`${req.method} ${req.url} host=${(req.headers.host ?? "").replace(/:\d+$/, ":<port>")}`),
);
const unix = https.createServer(
  {
    cert: readFileSync("tests/fixtures/server/certs/localhost.pem"),
    key: readFileSync("tests/fixtures/server/certs/localhost-key.pem"),
  },
  (req, res) => res.end(`unix ${req.method} ${req.url} host=${req.headers.host}`),
);

function send(label: string, options: https.RequestOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        console.log(label, res.statusCode, body);
        resolve();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log(label, "error", err.code);
      resolve();
    });
    req.end();
  });
}

server.listen(0, () => {
  const port = (server.address() as { port: number }).port;
  unix.listen(sock, async () => {
    const tcp: https.RequestOptions = { host: "localhost", port };
    await send("tcp", { ...tcp, path: "/a", ca, agent: false });
    await send("unix", { socketPath: sock, path: "/b", ca, agent: false });
    await send("unverified", { ...tcp, path: "/c", agent: false });
    await send("unchecked", { ...tcp, path: "/d", rejectUnauthorized: false, agent: false });
    try {
      https.request({ ...tcp, protocol: "http:" });
    } catch (err) {
      console.log("protocol", (err as NodeJS.ErrnoException).code, (err as Error).message);
    }
    server.close();
    unix.close();
  });
});
