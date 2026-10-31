// rejectUnauthorized is off only when it is false, as in Node: on a server
// with requestCert, null, 0, "" and undefined keep rejecting clients that
// send no certificate, and in tls.connect they keep rejecting a server
// certificate that does not verify.
import { readFileSync } from "node:fs";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f) => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const self = r("selfsigned.pem"), selfKey = r("selfsigned-key.pem");

const values = [
  ["false", false],
  ["true", true],
  ["null", null],
  ["0", 0],
  ['""', ""],
  ["undefined", undefined],
];

for (const [label, value] of values) {
  const events = [];
  const server = tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: value }, (s) => {
    events.push(`server authorized=${s.authorized} error=${s.authorizationError}`);
    s.end("ok");
  });
  const port = await new Promise((res) => server.listen(0, () => res(server.address().port)));
  await new Promise((done) => {
    const c = tls.connect({ port, ca, servername: "localhost" });
    c.on("secureConnect", () => events.push("client secureConnect"));
    c.on("data", (d) => events.push(`client data ${d}`));
    c.on("error", (e) => events.push(`client error ${e.code}`));
    c.on("close", () => setTimeout(() => done(undefined), 50));
  });
  console.log("rejectUnauthorized", label, "|", events.join(" ; "));
  await new Promise((res) => server.close(() => res(undefined)));
}

{
  const server = tls.createServer({ cert: self, key: selfKey }, (s) => s.end("ok"));
  const port = await new Promise((res) => server.listen(0, () => res(server.address().port)));
  for (const [label, value] of values) {
    const events = [];
    await new Promise((done) => {
      const c = tls.connect({ port, servername: "localhost", rejectUnauthorized: value });
      c.on("secureConnect", () => events.push(`secureConnect authorized=${c.authorized} error=${c.authorizationError}`));
      c.on("data", (d) => events.push(`data ${d}`));
      c.on("error", (e) => events.push(`error ${e.code}`));
      c.on("close", () => done(undefined));
    });
    console.log("tls.connect rejectUnauthorized", label, "|", events.join(" ; "));
  }
  server.close();
}
