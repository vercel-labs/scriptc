// dns.lookup callbacks whose options are known only at run time bind their
// parameters as checked-dynamic values. They keep the forms their
// declarations spell: an async callback returns its promise, a defaulted
// parameter takes its default when Node passes fewer arguments (no family
// with `all: true`), and a rest parameter packs the remaining arguments.
import * as dns from "node:dns";

type Options = dns.LookupOneOptions | dns.LookupAllOptions | number | undefined;

function lookupAsync(hostname: string, opts: Options): void {
  dns.lookup(hostname, opts as dns.LookupOneOptions, async (err, address) => {
    await Promise.resolve();
    console.log("async", err, Array.isArray(address) ? `${address.length} addresses` : address);
  });
}

function lookupDefault(hostname: string, opts: Options): void {
  dns.lookup(hostname, opts as dns.LookupOneOptions, (err, address, family = -1) => {
    console.log("default", err, Array.isArray(address) ? `${address.length} addresses` : address, family);
  });
}

function lookupRest(hostname: string, opts: Options): void {
  dns.lookup(hostname, opts as dns.LookupOneOptions, (err, ...rest) => {
    console.log("rest", err, rest.length, JSON.stringify(rest));
  });
}

function lookupAsyncFunction(hostname: string, opts: Options): void {
  dns.lookup(hostname, opts as dns.LookupOneOptions, async function (err, address, family = 0) {
    console.log("async function", err, address, family);
    return family;
  });
}

lookupAsync("127.0.0.1", { all: true });
lookupDefault("127.0.0.1", { all: true });
lookupRest("127.0.0.1", { family: 4 });
lookupAsyncFunction("127.0.0.1", 4);
