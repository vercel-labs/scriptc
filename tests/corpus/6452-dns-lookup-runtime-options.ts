// A custom lookup function over Node's lookup-option union passes its
// options to dns.lookup through a cast, so the callback's address is a
// string or, with `all: true`, an address list, whatever the overload the
// checker picked says. Array.isArray tests what arrived. The same function
// serves as net.connect's lookup, which Node calls with `all: true`.
import * as dns from "node:dns";
import * as net from "node:net";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function createSafeLookup(): (
  hostname: string,
  opts: dns.LookupOneOptions | dns.LookupAllOptions | number | undefined,
  callback: LookupCallback,
) => void {
  return function safeLookup(hostname, opts, callback) {
    dns.lookup(hostname, opts as dns.LookupOneOptions, (err, address, family) => {
      if (err) {
        callback(err, address as string, family);
        return;
      }
      if (Array.isArray(address)) {
        const v4: dns.LookupAddress[] = [];
        for (const entry of address) {
          if (entry.address === "10.0.0.1") {
            callback(new Error("blocked"), "", 0);
            return;
          }
          if (entry.family === 4) v4.push(entry);
        }
        callback(null, v4);
        return;
      }
      callback(null, address as string, family);
    });
  };
}

const lookup = createSafeLookup();
const show = (address: string | dns.LookupAddress[]): string =>
  typeof address === "string" ? address : JSON.stringify(address);

lookup("localhost", { family: 4 }, (err, address, family) => {
  console.log("one", err, show(address), family);
  lookup("localhost", { family: 4, all: false }, (err2, address2, family2) => {
    console.log("all false", err2, show(address2), family2);
    lookup("localhost", { all: true }, (err3, addresses) => {
      console.log("all true", err3, show(addresses));
      lookup("127.0.0.1", 4, (err4, address4, family4) => {
        console.log("family", err4, show(address4), family4);
        const server = net.createServer((socket) => socket.end("hello"));
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as net.AddressInfo).port;
          const socket = net.connect({ host: "localhost", port, lookup: createSafeLookup() });
          socket.on("data", (chunk: Buffer) => console.log("net", chunk.toString()));
          socket.on("close", () => server.close());
        });
      });
    });
  });
});
