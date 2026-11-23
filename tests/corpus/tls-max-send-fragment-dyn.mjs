// setMaxSendFragment() in the checked-dynamic lane (a plain-JS program):
// the same validation ladder, the same 512..16384 range, and the same cap
// on the wire through the dynamic member dispatch.
import tls from "node:tls";
import { readFileSync } from "node:fs";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const lines = [];
const chunks = [];
const server = tls.createServer({ key, cert }, (sock) => {
  sock.on("data", (chunk) => chunks.push(chunk.length));
});
server.listen(0, "127.0.0.1", () => {
  const client = tls.connect(
    { port: server.address().port, host: "127.0.0.1", servername: "localhost", ca },
    () => {
      try {
        client.setMaxSendFragment("x");
      } catch (e) {
        lines.push(`string ${e.name} ${e.code} ${e.message}`);
      }
      try {
        client.setMaxSendFragment(Number.NaN);
      } catch (e) {
        lines.push(`nan ${e.name} ${e.code} ${e.message}`);
      }
      lines.push(`low ${client.setMaxSendFragment(511)}`);
      lines.push(`set ${client.setMaxSendFragment(512)}`);
      client.write(Buffer.alloc(1000, 0x61));
      client.end();
    },
  );
  client.on("error", (err) => lines.push(`error ${err.message}`));
  client.on("data", () => {});
  client.on("close", () => {
    server.close(() => {
      for (const line of lines) console.log(line);
      console.log("chunks", chunks.join(","));
    });
  });
});
