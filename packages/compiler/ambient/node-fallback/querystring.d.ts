/* node:querystring — Node's legacy query-string codec (NOT
 * URLSearchParams: '+' means space on the parse side and escape encodes
 * spaces as %20). parse answers the null-prototype dictionary as a pure
 * index-signature record (repeated keys become string[] buckets;
 * @types/node's Dict adds an undefined arm the lowering tolerates);
 * stringify serializes string/number/boolean values and arrays of those
 * (Node's rules: arrays expand to repeated keys, null/undefined and
 * anything else serialize as the empty value). The maxKeys option lowers
 * (0 removes the cap, Node's rule); the custom encoder/decoder options
 * typecheck under the options-record stance and fence by name at the
 * call. decode/encode are Node's own aliases of parse/stringify. */
declare module "querystring" {
  export interface ParseOptions {
    maxKeys?: number;
    decodeURIComponent?: (str: string) => string;
    [option: string]: unknown;
  }
  export interface StringifyOptions {
    encodeURIComponent?: (str: string) => string;
    [option: string]: unknown;
  }
  export interface ParsedUrlQuery {
    [key: string]: string | string[] | undefined;
  }
  export interface ParsedUrlQueryInput {
    [key: string]:
      | string
      | number
      | boolean
      | bigint
      | ReadonlyArray<string | number | boolean | bigint>
      | null
      | undefined;
  }
  export function parse(
    str: string,
    sep?: string | null,
    eq?: string | null,
    options?: ParseOptions,
  ): ParsedUrlQuery;
  export function stringify(
    obj?: ParsedUrlQueryInput,
    sep?: string | null,
    eq?: string | null,
    options?: StringifyOptions,
  ): string;
  export const decode: typeof parse;
  export const encode: typeof stringify;
  export function escape(str: string): string;
  export function unescape(str: string): string;
}

declare module "node:querystring" {
  export * from "querystring";
}
