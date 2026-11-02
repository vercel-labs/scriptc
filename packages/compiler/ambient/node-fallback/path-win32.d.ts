/// <reference path="./path.d.ts" />

declare module "path/win32" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function toNamespacedPath(path: string): string;
  export function matchesGlob(path: string, pattern: string): boolean;
  export function parse(path: string): import("path").ParsedPath;
  export function format(pathObject: import("path").FormatInputPathObject): string;
  /* Node's deprecated alias of toNamespacedPath. */
  export function _makeLong(path: string): string;
  export const sep: "\\";
  export const delimiter: ";";
  /* Node's win32 object carries the other namespace too. */
  export const posix: typeof import("path/posix");
  export const win32: typeof import("path/win32");
}

declare module "node:path/win32" {
  export * from "path/win32";
}
