import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the dns module decided never to throw. */
export const dnsNeverThrow: readonly IrLibFn[] = [
  // scr_dns_resolver_is compares the value's kind and handle tag.
  "dns.resolverIs",
  // scr_dns_get_servers_default builds the server array from the default
  // resolver's list; the list was read when that resolver was created, and
  // turning it into strings cannot raise.
  "dns.promisesGetServers",
];
