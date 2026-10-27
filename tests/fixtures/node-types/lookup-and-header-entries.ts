// A dns lookup function whose options parameter is Node's lookup-option
// union (`LookupOneOptions | LookupAllOptions | number | undefined`) passes
// the options to dns.lookup as they are, and Object.entries over a header
// record cast to a narrower value type reads every entry.
import * as dns from "node:dns";
import type { OutgoingHttpHeaders } from "node:http";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function createLookup(): (
  hostname: string,
  opts: dns.LookupOneOptions | dns.LookupAllOptions | number | undefined,
  callback: LookupCallback,
) => void {
  return function lookup(hostname, opts, callback) {
    dns.lookup(hostname, opts as dns.LookupOneOptions, (err, address, family) => {
      if (err) {
        callback(err, address as string, family);
        return;
      }
      // With `all: true` Node answers an address list whatever the
      // overload the cast selected says.
      if (Array.isArray(address)) {
        const v4: dns.LookupAddress[] = [];
        for (const entry of address) if (entry.family === 4) v4.push(entry);
        // The same list read through casts to the declared element type.
        const viaCast = (address as dns.LookupAddress[]).map((entry) => entry.address);
        const viaShape = address.map((entry) => (entry as { address: string }).address);
        console.log("casts", viaCast.join(","), viaShape.join(","));
        callback(null, v4);
        return;
      }
      callback(null, address as string, family);
    });
  };
}

type HeadersLike = Headers | [string, string][] | OutgoingHttpHeaders;

function flatten(input: HeadersLike | undefined): string[] {
  const out: string[] = [];
  if (!input || input instanceof Headers || Array.isArray(input)) return out;
  for (const [name, value] of Object.entries(input as Record<string, string | string[] | undefined>)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.push(`${name}=${v}`);
    else out.push(`${name}=${value}`);
  }
  return out;
}

const lookup = createLookup();
lookup("localhost", { family: 4 }, (err, address, family) => {
  console.log("one", err, address, family);
  lookup("localhost", { all: true }, (err2, addresses) => {
    console.log("all", err2, JSON.stringify(addresses));
    lookup("127.0.0.1", 4, (err3, address3, family3) => {
      console.log("family", err3, address3, family3);
      console.log(flatten({ accept: "text/plain", "x-list": ["a", "b"], "x-skip": undefined }).join(","));
    });
  });
});
