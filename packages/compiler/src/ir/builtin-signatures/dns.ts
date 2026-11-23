import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The dns builtin call slots. */
export const dnsSignatures = defineLibFnSignatures({
  "dns.lookup": { argTypes: [STRING, F64, null], result: VOID },
  /** Node's argument forms with dyn callbacks: lookup(hostname, options,
   * callback) and lookupService(address, port, callback). */
  "dns.lookupDyn": { argTypes: [DYN, DYN, DYN, BOOL], result: VOID },
  "dns.lookupService": { argTypes: [DYN, DYN, DYN, BOOL], result: VOID },
  /** node:dns/promises: lookup(hostname, options) and lookupService(address,
   * port) over the callback forms; the promise fulfills with the dyn
   * { address, family } (array for all: true) / { hostname, service }.
   * Argument errors throw synchronously (may-throw), unlike the
   * util.promisify forms below. */
  "dns.promisesLookup": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "dns.promisesLookupService": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "dns.getServers": { argTypes: [], result: DYN },
  "dns.getDefaultResultOrder": { argTypes: [], result: STRING },
  "dns.setDefaultResultOrder": { argTypes: [DYN], result: VOID },
  /** The stub resolver (scr_dns_resolve.c): the binding names the c-ares
   * query ("queryA", "getHostByAddr", …), `typed` says the callback's
   * result parameter cannot take the undefined Node passes on an error,
   * and the promise forms fulfill with the dyn result. Argument errors
   * throw synchronously in both forms (Node validates before it queues
   * the query). */
  "dns.resolveChk": { argTypes: [STRING, DYN, DYN, DYN, BOOL], result: VOID },
  "dns.resolvePromise": { argTypes: [STRING, DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** resolve(hostname, rrtype[, callback]): the rrtype picks the binding
   * at run time (Node's resolveMap). */
  "dns.resolveRrChk": { argTypes: [DYN, DYN, DYN, BOOL], result: VOID },
  "dns.resolveRrPromise": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** The Resolver handle (SCR_DYNH_DNS_RESOLVER): the constructor's
   * options, the instanceof test, and the servers of the module defaults.
   * A handle's own methods are dyn calls on the handle value, so they need
   * no entry here. */
  "dns.resolverNew": { argTypes: [DYN, BOOL], result: DYN },
  "dns.resolverIs": { argTypes: [DYN, BOOL], result: BOOL },
  "dns.setServers": { argTypes: [DYN], result: VOID },
  "dns.promisesSetServers": { argTypes: [DYN], result: VOID },
  "dns.promisesGetServers": { argTypes: [BOOL], result: DYN },
  /** util.promisify(dns.lookup) and util.promisify(dns.lookupService):
   * [hostname, options] and [address, port] → a promise of the
   * checked-dynamic result object (the address array with options.all),
   * or rejected with the error; never throws. */
  "dns.lookupPromise": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "dns.lookupServicePromise": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
});
