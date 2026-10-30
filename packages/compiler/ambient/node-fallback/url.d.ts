/// <reference path="./querystring.d.ts" />

/* node:url — the file-URL bridge pair. fileURLToPath accepts a URL value
 * or a URL string and throws Node's TypeErrors (non-file scheme, encoded
 * slashes, non-empty host); pathToFileURL resolves the path and percent-
 * encodes it into a file: URL. The legacy API: parse() answers a Url
 * object, format() serializes a Url-shaped object, a string, or a URL,
 * resolve() resolves one URL string against another, the domain pair
 * converts a hostname to and from its Punycode form, and urlToHttpOptions
 * builds http.request options from a URL. */
declare module "url" {
  export type URL = globalThis.URL;
  export type URLSearchParams = globalThis.URLSearchParams;
  export const URL: typeof globalThis.URL;
  export const URLSearchParams: typeof globalThis.URLSearchParams;
  export function fileURLToPath(url: string | URL, options?: { windows?: boolean }): string;
  export function fileURLToPathBuffer(url: string | URL, options?: { windows?: boolean }): Buffer;
  export function pathToFileURL(path: string, options?: { windows?: boolean }): URL;
  export interface UrlObject {
    auth?: string | null | undefined;
    hash?: string | null | undefined;
    host?: string | null | undefined;
    hostname?: string | null | undefined;
    href?: string | null | undefined;
    pathname?: string | null | undefined;
    protocol?: string | null | undefined;
    search?: string | null | undefined;
    slashes?: boolean | null | undefined;
    port?: string | number | null | undefined;
    query?: string | null | import("querystring").ParsedUrlQueryInput | undefined;
  }
  export interface Url {
    auth: string | null;
    hash: string | null;
    host: string | null;
    hostname: string | null;
    href: string;
    path: string | null;
    pathname: string | null;
    protocol: string | null;
    search: string | null;
    slashes: boolean | null;
    port: string | null;
    query: string | null | import("querystring").ParsedUrlQuery;
  }
  export interface UrlWithParsedQuery extends Url {
    query: import("querystring").ParsedUrlQuery;
  }
  export interface UrlWithStringQuery extends Url {
    query: string | null;
  }
  export interface URLFormatOptions {
    auth?: boolean | undefined;
    fragment?: boolean | undefined;
    search?: boolean | undefined;
    unicode?: boolean | undefined;
  }
  export function parse(
    urlString: string,
    parseQueryString?: false,
    slashesDenoteHost?: boolean,
  ): UrlWithStringQuery;
  export function parse(
    urlString: string,
    parseQueryString: true,
    slashesDenoteHost?: boolean,
  ): UrlWithParsedQuery;
  export function parse(
    urlString: string,
    parseQueryString: boolean,
    slashesDenoteHost?: boolean,
  ): Url;
  export function format(urlObject: URL, options?: URLFormatOptions): string;
  export function format(urlObject: UrlObject | string): string;
  export function resolve(from: string, to: string): string;
  export function domainToASCII(domain: string): string;
  export function domainToUnicode(domain: string): string;
  /** urlToHttpOptions's null-prototype request options. */
  export interface UrlHttpOptions {
    protocol: string;
    hostname: string;
    hash: string;
    search: string;
    pathname: string;
    path: string;
    href: string;
    port?: number;
    auth?: string;
  }
  export function urlToHttpOptions(url: URL): UrlHttpOptions;
}

declare module "node:url" {
  export * from "url";
}
