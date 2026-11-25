/// <reference path="./dns.d.ts" />

/* node:dns/promises — lookup and lookupService as promises over the same
 * resolution as the callback forms: argument errors throw synchronously,
 * failures reject with the callbacks' errors. */
declare module "dns/promises" {
  import type {
    AnyRecord,
    CaaRecord,
    LookupAddress,
    LookupAllOptions,
    LookupOneOptions,
    LookupOptions,
    MxRecord,
    NaptrRecord,
    RecordWithTtl,
    ResolveOptions,
    ResolveWithTtlOptions,
    ResolverOptions,
    SoaRecord,
    SrvRecord,
    TlsaRecord,
  } from "dns";
  export function lookup(hostname: string, family: number): Promise<LookupAddress>;
  export function lookup(hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
  export function lookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  export function lookup(
    hostname: string,
    options: LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]>;
  export function lookup(hostname: string): Promise<LookupAddress>;
  export function lookupService(
    address: string,
    port: number,
  ): Promise<{ hostname: string; service: string }>;
  /* The stub resolver's queries as promises; argument errors throw
   * synchronously, as in Node. */
  export function resolve(hostname: string): Promise<string[]>;
  export function resolve(
    hostname: string,
    rrtype: "A" | "AAAA" | "CNAME" | "NS" | "PTR",
  ): Promise<string[]>;
  export function resolve(hostname: string, rrtype: "ANY"): Promise<AnyRecord[]>;
  export function resolve(hostname: string, rrtype: "CAA"): Promise<CaaRecord[]>;
  export function resolve(hostname: string, rrtype: "MX"): Promise<MxRecord[]>;
  export function resolve(hostname: string, rrtype: "NAPTR"): Promise<NaptrRecord[]>;
  export function resolve(hostname: string, rrtype: "SOA"): Promise<SoaRecord>;
  export function resolve(hostname: string, rrtype: "SRV"): Promise<SrvRecord[]>;
  export function resolve(hostname: string, rrtype: "TLSA"): Promise<TlsaRecord[]>;
  export function resolve(hostname: string, rrtype: "TXT"): Promise<string[][]>;
  export function resolve(
    hostname: string,
    rrtype: string,
  ): Promise<
    | string[]
    | CaaRecord[]
    | MxRecord[]
    | NaptrRecord[]
    | SoaRecord
    | SrvRecord[]
    | TlsaRecord[]
    | string[][]
    | AnyRecord[]
  >;
  export function resolve4(hostname: string): Promise<string[]>;
  export function resolve4(
    hostname: string,
    options: ResolveWithTtlOptions,
  ): Promise<RecordWithTtl[]>;
  export function resolve4(
    hostname: string,
    options: ResolveOptions,
  ): Promise<RecordWithTtl[] | string[]>;
  export function resolve6(hostname: string): Promise<string[]>;
  export function resolve6(
    hostname: string,
    options: ResolveWithTtlOptions,
  ): Promise<RecordWithTtl[]>;
  export function resolve6(
    hostname: string,
    options: ResolveOptions,
  ): Promise<RecordWithTtl[] | string[]>;
  export function resolveAny(hostname: string): Promise<AnyRecord[]>;
  export function resolveCaa(hostname: string): Promise<CaaRecord[]>;
  export function resolveCname(hostname: string): Promise<string[]>;
  export function resolveMx(hostname: string): Promise<MxRecord[]>;
  export function resolveNaptr(hostname: string): Promise<NaptrRecord[]>;
  export function resolveNs(hostname: string): Promise<string[]>;
  export function resolvePtr(hostname: string): Promise<string[]>;
  export function resolveSoa(hostname: string): Promise<SoaRecord>;
  export function resolveSrv(hostname: string): Promise<SrvRecord[]>;
  export function resolveTlsa(hostname: string): Promise<TlsaRecord[]>;
  export function resolveTxt(hostname: string): Promise<string[][]>;
  export function reverse(ip: string): Promise<string[]>;
  /* An independent resolver: its own servers, over the same queries. */
  class Resolver {
    constructor(options?: ResolverOptions);
    cancel(): void;
    getServers(): string[];
    setServers(servers: readonly string[]): void;
    setLocalAddress(ipv4?: string, ipv6?: string): void;
    resolve: typeof resolve;
    resolve4: typeof resolve4;
    resolve6: typeof resolve6;
    resolveAny: typeof resolveAny;
    resolveCaa: typeof resolveCaa;
    resolveCname: typeof resolveCname;
    resolveMx: typeof resolveMx;
    resolveNaptr: typeof resolveNaptr;
    resolveNs: typeof resolveNs;
    resolvePtr: typeof resolvePtr;
    resolveSoa: typeof resolveSoa;
    resolveSrv: typeof resolveSrv;
    resolveTlsa: typeof resolveTlsa;
    resolveTxt: typeof resolveTxt;
    reverse: typeof reverse;
  }
  export { Resolver };
  export function getServers(): string[];
  export function setServers(servers: readonly string[]): void;
  export function getDefaultResultOrder(): "ipv4first" | "ipv6first" | "verbatim";
  export function setDefaultResultOrder(order: "ipv4first" | "ipv6first" | "verbatim"): void;
  /* The `code` a resolver failure carries. */
  export const NODATA: "ENODATA";
  export const FORMERR: "EFORMERR";
  export const SERVFAIL: "ESERVFAIL";
  export const NOTFOUND: "ENOTFOUND";
  export const NOTIMP: "ENOTIMP";
  export const REFUSED: "EREFUSED";
  export const BADQUERY: "EBADQUERY";
  export const BADNAME: "EBADNAME";
  export const BADFAMILY: "EBADFAMILY";
  export const BADRESP: "EBADRESP";
  export const CONNREFUSED: "ECONNREFUSED";
  export const TIMEOUT: "ETIMEOUT";
  export const EOF: "EOF";
  export const FILE: "EFILE";
  export const NOMEM: "ENOMEM";
  export const DESTRUCTION: "EDESTRUCTION";
  export const BADSTR: "EBADSTR";
  export const BADFLAGS: "EBADFLAGS";
  export const NONAME: "ENONAME";
  export const BADHINTS: "EBADHINTS";
  export const NOTINITIALIZED: "ENOTINITIALIZED";
  export const LOADIPHLPAPI: "ELOADIPHLPAPI";
  export const ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS";
  export const CANCELLED: "ECANCELLED";
}

declare module "node:dns/promises" {
  export * from "dns/promises";
}
