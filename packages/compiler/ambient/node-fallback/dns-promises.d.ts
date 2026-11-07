/// <reference path="./dns.d.ts" />

/* node:dns/promises — lookup and lookupService as promises over the same
 * resolution as the callback forms: argument errors throw synchronously,
 * failures reject with the callbacks' errors. */
declare module "dns/promises" {
  import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "dns";
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
  export function getServers(): string[];
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
