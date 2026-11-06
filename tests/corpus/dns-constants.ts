// node:dns and node:dns/promises export the getaddrinfo hint flags and
// the resolver error codes Node does: the same numbers and strings from
// the module objects, named imports and require bindings.
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";
import { ADDRCONFIG, ALL, V4MAPPED, NODATA, NOTFOUND } from "node:dns";
import { TIMEOUT, CANCELLED } from "node:dns/promises";

console.log("hints", dns.ADDRCONFIG, dns.ALL, dns.V4MAPPED);
console.log("hints combined", dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL);
console.log("named hints", ADDRCONFIG, ALL, V4MAPPED);
console.log("types", typeof dns.ADDRCONFIG, typeof dns.NODATA);

const codes: [string, string][] = [
  ["NODATA", dns.NODATA],
  ["FORMERR", dns.FORMERR],
  ["SERVFAIL", dns.SERVFAIL],
  ["NOTFOUND", dns.NOTFOUND],
  ["NOTIMP", dns.NOTIMP],
  ["REFUSED", dns.REFUSED],
  ["BADQUERY", dns.BADQUERY],
  ["BADNAME", dns.BADNAME],
  ["BADFAMILY", dns.BADFAMILY],
  ["BADRESP", dns.BADRESP],
  ["CONNREFUSED", dns.CONNREFUSED],
  ["TIMEOUT", dns.TIMEOUT],
  ["EOF", dns.EOF],
  ["FILE", dns.FILE],
  ["NOMEM", dns.NOMEM],
  ["DESTRUCTION", dns.DESTRUCTION],
  ["BADSTR", dns.BADSTR],
  ["BADFLAGS", dns.BADFLAGS],
  ["NONAME", dns.NONAME],
  ["BADHINTS", dns.BADHINTS],
  ["NOTINITIALIZED", dns.NOTINITIALIZED],
  ["LOADIPHLPAPI", dns.LOADIPHLPAPI],
  ["ADDRGETNETWORKPARAMS", dns.ADDRGETNETWORKPARAMS],
  ["CANCELLED", dns.CANCELLED],
];
for (const [name, code] of codes) console.log(name, code);

console.log("named codes", NODATA, NOTFOUND, TIMEOUT, CANCELLED);
const promiseCodes: [string, string][] = [
  ["NODATA", dnsPromises.NODATA],
  ["FORMERR", dnsPromises.FORMERR],
  ["SERVFAIL", dnsPromises.SERVFAIL],
  ["NOTFOUND", dnsPromises.NOTFOUND],
  ["NOTIMP", dnsPromises.NOTIMP],
  ["REFUSED", dnsPromises.REFUSED],
  ["BADQUERY", dnsPromises.BADQUERY],
  ["BADNAME", dnsPromises.BADNAME],
  ["BADFAMILY", dnsPromises.BADFAMILY],
  ["BADRESP", dnsPromises.BADRESP],
  ["CONNREFUSED", dnsPromises.CONNREFUSED],
  ["TIMEOUT", dnsPromises.TIMEOUT],
  ["EOF", dnsPromises.EOF],
  ["FILE", dnsPromises.FILE],
  ["NOMEM", dnsPromises.NOMEM],
  ["DESTRUCTION", dnsPromises.DESTRUCTION],
  ["BADSTR", dnsPromises.BADSTR],
  ["BADFLAGS", dnsPromises.BADFLAGS],
  ["NONAME", dnsPromises.NONAME],
  ["BADHINTS", dnsPromises.BADHINTS],
  ["NOTINITIALIZED", dnsPromises.NOTINITIALIZED],
  ["LOADIPHLPAPI", dnsPromises.LOADIPHLPAPI],
  ["ADDRGETNETWORKPARAMS", dnsPromises.ADDRGETNETWORKPARAMS],
  ["CANCELLED", dnsPromises.CANCELLED],
];
console.log("promise codes", promiseCodes.map(([, code]) => code).join(" "));
console.log(
  "promises agree",
  promiseCodes.every(([name, code]) => codes.find(([n]) => n === name)?.[1] === code),
);
