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
  /* The nameservers /etc/resolv.conf lists. */
  export function getServers(): string[];
  export function getDefaultResultOrder(): "ipv4first" | "ipv6first" | "verbatim";
  export function setDefaultResultOrder(order: "ipv4first" | "ipv6first" | "verbatim"): void;
  /* The promise forms (node:dns/promises). */
  export const promises: typeof import("dns/promises");
}

declare module "node:dns" {
  export * from "dns";
}
