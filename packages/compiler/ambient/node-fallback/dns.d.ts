/// <reference path="./dns-promises.d.ts" />

/* node:dns — the lookup slice (scr_dgram.c hosts it; getaddrinfo runs AT
 * CALL TIME and the callback defers to the next loop turn — SEMANTICS.md
 * documents the blocking divergence). Only the { family: 4 } options
 * form lowers; failures deliver Node's error shape ("getaddrinfo
 * ENOTFOUND <hostname>") as the callback's Error argument, with "" for
 * the address where Node passes undefined. */
declare module "dns" {
  export interface LookupAddress {
    address: string;
    family: number;
  }
  export interface LookupOptions {
    family?: number | "IPv4" | "IPv6";
    hints?: number;
    all?: boolean;
    order?: "ipv4first" | "ipv6first" | "verbatim";
    verbatim?: boolean;
  }
  export interface LookupOneOptions extends LookupOptions {
    all?: false;
  }
  export interface LookupAllOptions extends LookupOptions {
    all: true;
  }
  /* The callback comes with the other lookup deliveries (literal
   * addresses on the next tick); the options follow lib/dns.js. */
  export function lookup(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    family: number,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    options: LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    options: LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ): void;
  /* getnameinfo with NI_NAMEREQD: the host's name and the port's service
   * name (the number when it has none). */
  export function lookupService(
    address: string,
    port: number,
    callback: (err: NodeJS.ErrnoException | null, hostname: string, service: string) => void,
  ): void;
  export interface ResolveOptions {
    ttl: boolean;
  }
  export interface ResolveWithTtlOptions extends ResolveOptions {
    ttl: true;
  }
  export interface RecordWithTtl {
    address: string;
    ttl: number;
  }
  export type AnyRecordWithTtl = AnyARecord | AnyAaaaRecord;
  export interface AnyARecord extends RecordWithTtl {
    type: "A";
  }
  export interface AnyAaaaRecord extends RecordWithTtl {
    type: "AAAA";
  }
  export interface CaaRecord {
    critical: number;
    issue?: string | undefined;
    issuewild?: string | undefined;
    iodef?: string | undefined;
    contactemail?: string | undefined;
    contactphone?: string | undefined;
  }
  export interface AnyCaaRecord extends CaaRecord {
    type: "CAA";
  }
  export interface MxRecord {
    priority: number;
    exchange: string;
  }
  export interface AnyMxRecord extends MxRecord {
    type: "MX";
  }
  export interface NaptrRecord {
    flags: string;
    service: string;
    regexp: string;
    replacement: string;
    order: number;
    preference: number;
  }
  export interface AnyNaptrRecord extends NaptrRecord {
    type: "NAPTR";
  }
  export interface SoaRecord {
    nsname: string;
    hostmaster: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minttl: number;
  }
  export interface AnySoaRecord extends SoaRecord {
    type: "SOA";
  }
  export interface SrvRecord {
    priority: number;
    weight: number;
    port: number;
    name: string;
  }
  export interface AnySrvRecord extends SrvRecord {
    type: "SRV";
  }
  export interface TlsaRecord {
    certUsage: number;
    selector: number;
    match: number;
    data: ArrayBuffer;
  }
  export interface AnyTlsaRecord extends TlsaRecord {
    type: "TLSA";
  }
  export interface AnyTxtRecord {
    type: "TXT";
    entries: string[];
  }
  export interface AnyNsRecord {
    type: "NS";
    value: string;
  }
  export interface AnyPtrRecord {
    type: "PTR";
    value: string;
  }
  export interface AnyCnameRecord {
    type: "CNAME";
    value: string;
  }
  export type AnyRecord =
    | AnyARecord
    | AnyAaaaRecord
    | AnyCaaRecord
    | AnyCnameRecord
    | AnyMxRecord
    | AnyNaptrRecord
    | AnyNsRecord
    | AnyPtrRecord
    | AnySoaRecord
    | AnySrvRecord
    | AnyTlsaRecord
    | AnyTxtRecord;
  /* The stub resolver's queries: a name, an optional per-query option
   * record, and a callback whose result has the rrtype's shape. */
  export function resolve(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "A" | "AAAA" | "CNAME" | "NS" | "PTR",
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "ANY",
    callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "CAA",
    callback: (err: NodeJS.ErrnoException | null, address: CaaRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "MX",
    callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "NAPTR",
    callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "SOA",
    callback: (err: NodeJS.ErrnoException | null, addresses: SoaRecord) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "SRV",
    callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "TLSA",
    callback: (err: NodeJS.ErrnoException | null, addresses: TlsaRecord[]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: "TXT",
    callback: (err: NodeJS.ErrnoException | null, addresses: string[][]) => void,
  ): void;
  export function resolve(
    hostname: string,
    rrtype: string,
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses:
        | string[]
        | CaaRecord[]
        | MxRecord[]
        | NaptrRecord[]
        | SoaRecord
        | SrvRecord[]
        | TlsaRecord[]
        | string[][]
        | AnyRecord[],
    ) => void,
  ): void;
  export function resolve4(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolve4(
    hostname: string,
    options: ResolveWithTtlOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: RecordWithTtl[]) => void,
  ): void;
  export function resolve4(
    hostname: string,
    options: ResolveOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: RecordWithTtl[] | string[]) => void,
  ): void;
  export function resolve6(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolve6(
    hostname: string,
    options: ResolveWithTtlOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: RecordWithTtl[]) => void,
  ): void;
  export function resolve6(
    hostname: string,
    options: ResolveOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: RecordWithTtl[] | string[]) => void,
  ): void;
  export function resolveAny(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: AnyRecord[]) => void,
  ): void;
  export function resolveCaa(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, records: CaaRecord[]) => void,
  ): void;
  export function resolveCname(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolveMx(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: MxRecord[]) => void,
  ): void;
  export function resolveNaptr(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: NaptrRecord[]) => void,
  ): void;
  export function resolveNs(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolvePtr(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void;
  export function resolveSoa(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, address: SoaRecord) => void,
  ): void;
  export function resolveSrv(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: SrvRecord[]) => void,
  ): void;
  export function resolveTlsa(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, addresses: TlsaRecord[]) => void,
  ): void;
  export function resolveTxt(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, records: string[][]) => void,
  ): void;
  /* The names of an address's hosts (the reverse lookup). */
  export function reverse(
    ip: string,
    callback: (err: NodeJS.ErrnoException | null, hostnames: string[]) => void,
  ): void;
  export interface ResolverOptions {
    timeout?: number | undefined;
    tries?: number | undefined;
    maxTimeout?: number | undefined;
  }
  /* An independent resolver: its own servers, over the same query forms. */
  export class Resolver {
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
  /* The nameservers /etc/resolv.conf lists. */
  export function getServers(): string[];
  /* The nameservers every resolver starts from. */
  export function setServers(servers: readonly string[]): void;
  export function getDefaultResultOrder(): "ipv4first" | "ipv6first" | "verbatim";
  export function setDefaultResultOrder(order: "ipv4first" | "ipv6first" | "verbatim"): void;
  /* Supported getaddrinfo hints for dns.lookup's options.hints. */
  export const ADDRCONFIG: number;
  export const ALL: number;
  export const V4MAPPED: number;
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
  /* The promise forms (node:dns/promises). */
  export const promises: typeof import("dns/promises");
}

declare module "node:dns" {
  export * from "dns";
}
