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
}

declare module "node:dns/promises" {
  export * from "dns/promises";
}
