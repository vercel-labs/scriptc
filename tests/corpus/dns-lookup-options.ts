// dns.lookup and dns.promises.lookup option handling: hints are converted
// with ToUint32 and checked against the getaddrinfo flags
// (dns.ADDRCONFIG, dns.V4MAPPED, dns.ALL), an array or null counts as an
// options object the way Node's typeof test does, and the argument errors
// match Node's messages. Both forms reach getaddrinfo with the same flags.
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";

const emptyOptions: any = [];
const nullOptions: any = null;

function lookup(label: string, options: any): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      dns.lookup("localhost", options, (err, address, family) => {
        if (err) console.log(label, "error", (err as NodeJS.ErrnoException).code);
        else console.log(label, "address", address, family);
        resolve();
      });
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(label, "threw", e.code, e.message);
      resolve();
    }
  });
}

async function lookupPromise(label: string, options: any): Promise<void> {
  try {
    const result = await dnsPromises.lookup("localhost", options);
    console.log(label, "address", result.address, result.family);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.code, e.message);
  }
}

await lookup("callback/default", { hints: dns.ADDRCONFIG });
await lookup("callback/zero", { hints: 0 });
await lookup("callback/nan", { hints: NaN });
await lookup("callback/infinity", { hints: Infinity });
await lookup("callback/wrap", { hints: 4294967296 });
await lookup("callback/wrap-flag", { hints: dns.ADDRCONFIG + 4294967296 });
await lookup("callback/array", emptyOptions);
await lookup("callback/null", nullOptions);
await lookup("callback/fraction", { hints: 1.5 });
await lookup("callback/negative", { hints: -1 });
await lookup("callback/passive", { hints: 1 });
await lookup("callback/string", { hints: "1" as unknown as number });

// The all: true shape reaches getaddrinfo with the same flags. One at a
// time: fired together, these three callbacks settle in whichever order the
// threadpool finishes, and the two runs' orders could differ (the awaited
// lookups below are already ordered by their awaits).
function lookupAll(label: string, hints: number): Promise<void> {
  return new Promise<void>((resolve) => {
    dns.lookup("localhost", { hints, all: true }, (err, addresses) => {
      console.log(label, err, addresses.length, addresses[0].address);
      resolve();
    });
  });
}

await lookupAll("callback/v4mapped", dns.V4MAPPED);
await lookupAll("callback/all", dns.ALL);
await lookupAll("callback/combo", dns.ADDRCONFIG | dns.V4MAPPED);

await lookupPromise("promise/default", { hints: dns.ADDRCONFIG });
await lookupPromise("promise/zero", { hints: 0 });
await lookupPromise("promise/nan", { hints: NaN });
await lookupPromise("promise/infinity", { hints: Infinity });
await lookupPromise("promise/wrap", { hints: 4294967296 });
await lookupPromise("promise/wrap-flag", { hints: dns.ADDRCONFIG + 4294967296 });
await lookupPromise("promise/array", emptyOptions);
await lookupPromise("promise/null", nullOptions);
await lookupPromise("promise/fraction", { hints: 1.5 });
await lookupPromise("promise/negative", { hints: -1 });
await lookupPromise("promise/passive", { hints: 1 });
await lookupPromise("promise/string", { hints: "1" as unknown as number });

console.log("promise/v4mapped", JSON.stringify(await dnsPromises.lookup("localhost", { hints: dns.V4MAPPED, all: true })));
console.log("promise/all", JSON.stringify(await dnsPromises.lookup("localhost", { hints: dns.ALL, all: true })));
console.log("promise/combo", JSON.stringify(await dnsPromises.lookup("localhost", { hints: dns.ADDRCONFIG | dns.V4MAPPED, all: true })));

// Number options select the family; anything else is the options error.
await lookupPromise("promise/family", 4);
const booleanOptions: any = true;
const functionOptions: any = () => 1;
await lookupPromise("promise/options-boolean", booleanOptions);
await lookupPromise("promise/options-function", functionOptions);
await lookupPromise("promise/options-family", 7);
