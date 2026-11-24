// getSession() and getTLSTicket() hand out independent buffers: mutating a
// returned Buffer must not change what the next call answers, as Node's
// copies are independent. The program prints the relationships (never the
// provider's ticket bytes), so both lanes agree.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

const server = tls.createServer({ cert, key, maxVersion: "TLSv1.2" }, (sock) => {
  sock.on("data", () => {});
  sock.end("");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect(
    { port, host: "127.0.0.1", servername: "localhost", ca, maxVersion: "TLSv1.2" },
    () => {
      const ticket1 = client.getTLSTicket();
      const ticket2 = client.getTLSTicket();
      if (ticket1 === undefined || ticket2 === undefined) {
        console.log("ticket missing");
      } else {
        console.log("ticket copies", ticket1 !== ticket2, ticket1.equals(ticket2));
        const first = ticket1[0]!;
        ticket1[0] = first ^ 0xff;
        const ticket3 = client.getTLSTicket()!;
        console.log("ticket after mutation", ticket3[0] !== ticket1[0], ticket3[0] === ticket2[0]);
      }
      const session1 = client.getSession();
      const session2 = client.getSession();
      if (session1 === null || session2 === null) {
        console.log("session missing");
      } else {
        console.log("session copies", session1 !== session2, session1.equals(session2));
        const firstByte = session1[0]!;
        session1[0] = firstByte ^ 0xff;
        const session3 = client.getSession()!;
        console.log("session after mutation", session3[0] !== session1[0], session3[0] === session2[0]);
      }
    },
  );
  client.on("data", () => {});
  client.on("close", () => server.close(() => console.log("closed")));
});
