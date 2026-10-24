// The last handshake flight from JavaScript: a TLS 1.3 client that
// destroys its socket in secureConnect or a tick never sends its Finished,
// so the server reports a hang-up; one that waits for an immediate, or
// ends the socket, completes the server's handshake.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);

for (const how of ["destroy", "tick", "immediate", "end"]) {
  const events = [];
  const server = tls.createServer({ cert, key }, () => events.push("secureConnection"));
  server.on("tlsClientError", (err) => events.push(`tlsClientError ${err.code}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => {
    const client = tls.connect({ port: server.address().port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
      if (how === "destroy") client.destroy();
      else if (how === "tick") process.nextTick(() => client.destroy());
      else if (how === "immediate") setImmediate(() => client.destroy());
      else client.end();
    });
    client.on("close", () => setTimeout(resolve, 100));
  });
  console.log(how, events.join(" ; "));
  server.close();
}
