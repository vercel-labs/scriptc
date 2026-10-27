// A pooled socket the server closes while idle leaves the agent's free
// list, so the next request dials a new connection. An https keepAlive
// agent reuses its TLS connections the same way (a servername that is
// empty or equal to the host keys like none), and idle pooled sockets do
// not keep the process alive.
import * as http from "node:http";
import * as https from "node:https";
import { readFileSync } from "node:fs";

let connections = 0;
const server = http.createServer((req, res) => res.end(`ok ${req.url}`));
server.keepAliveTimeout = 100;
server.keepAliveTimeoutBuffer = 0;
server.on("connection", () => connections++);

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
let tlsConnections = 0;
const secure = https.createServer({ key, cert }, (req, res) => res.end(`secure ${req.url}`));
secure.on("connection", () => tlsConnections++);

function get(port: number, agent: http.Agent, path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent: agent }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve(`${body} reused=${req.reusedSocket}`));
    });
    req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true });
  console.log(await get(port, agent, "/1"));
  await new Promise<void>((r) => setTimeout(r, 300));
  console.log("free after server timeout", Object.keys(agent.freeSockets).length);
  console.log(await get(port, agent, "/2"));
  console.log("connections", connections);
  server.close();
  secure.listen(0, "127.0.0.1", async () => {
    const sport = (secure.address() as { port: number }).port;
    const sagent = new https.Agent({ keepAlive: true });
    for (const path of ["/s1", "/s2"]) {
      const out = await new Promise<string>((resolve) => {
        const req = https.request({ host: "localhost", port: sport, path, agent: sagent, ca: ca }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve(`${body} reused=${req.reusedSocket}`));
        });
        req.on("error", (err: Error) => resolve(`error ${err.message}`));
        req.end();
      });
      console.log(out);
    }
    for (const name of ["", "localhost"]) {
      const out = await new Promise<string>((resolve) => {
        const req = https.request(
          { host: "localhost", port: sport, path: "/sn", agent: sagent, ca: ca, servername: name },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => resolve(`${body} servername=${JSON.stringify(name)} reused=${req.reusedSocket}`));
          },
        );
        req.on("error", (err: Error) => resolve(`error ${err.message}`));
        req.end();
      });
      console.log(out);
    }
    console.log("tls connections", tlsConnections);
    secure.close();
    secure.closeIdleConnections();
    // the pooled client sockets are unref'd: the process exits with them open
  });
});
process.on("exit", () => console.log("exit"));
