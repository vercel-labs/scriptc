/* node:punycode (deprecated, DEP0040) — punycode.js 2.1.0: decode and
 * toUnicode throw its RangeErrors on malformed input; ucs2 converts
 * between strings and UTF-16 code point arrays. */
declare module "punycode" {
  export function decode(string: string): string;
  export function encode(string: string): string;
  export function toUnicode(domain: string): string;
  export function toASCII(domain: string): string;
  export namespace ucs2 {
    function decode(string: string): number[];
    function encode(codePoints: readonly number[]): string;
  }
  export const version: string;
}

declare module "node:punycode" {
  export * from "punycode";
}
