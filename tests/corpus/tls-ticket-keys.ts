// A tls.Server's ticket key material: getTicketKeys() answers 48 bytes and
// a fresh copy per call, setTicketKeys installs a 48-byte Buffer and the
// getter answers it back, and a wrong length throws Node's assertion. The
// program prints the relationships and the error identity, never the keys
// the server would mint under.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

const server = tls.createServer({ cert, key });
server.listen(0, "127.0.0.1", () => {
  const first = server.getTicketKeys();
  const second = server.getTicketKeys();
  console.log("keys", first.length, Buffer.isBuffer(first), first !== second, first.equals(second));
  const byte = first[0]!;
  first[0] = byte ^ 0xff;
  console.log("mutation isolated", server.getTicketKeys()[0] === second[0]);

  const replacement = Buffer.alloc(48, 0x5a);
  server.setTicketKeys(replacement);
  console.log("installed", server.getTicketKeys().equals(replacement));

  const attempt = (label: string, keys: Buffer): void => {
    try {
      server.setTicketKeys(keys);
      console.log(label, "accepted");
    } catch (err) {
      const e = err as Error & { code?: string };
      console.log(label, e.code, JSON.stringify(e.message));
    }
  };
  attempt("short", Buffer.alloc(47));
  attempt("long", Buffer.alloc(49));
  console.log("unchanged", server.getTicketKeys().equals(replacement));
  server.close(() => console.log("closed"));
});
