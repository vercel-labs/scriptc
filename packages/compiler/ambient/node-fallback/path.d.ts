/// <reference path="./path-posix.d.ts" />
/// <reference path="./path-win32.d.ts" />

/* node:path — the TARGET platform's implementation (Node's rule): posix
 * on posix triples, path.win32 under a win32 triple, with the posix and
 * win32 namespaces answering their own platform anywhere. Every function
 * is a pure string algorithm matching Node's implementations
 * exactly; join/resolve are variadic like Node's. */
declare module "path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function toNamespacedPath(path: string): string;
  /* matchesGlob() is Node's glob matcher: brace expansion, extglobs, POSIX
   * classes and the ** and dot rules. */
  export function matchesGlob(path: string, pattern: string): boolean;
  /* parse() splits a path into its root, directory, base, extension and
   * name; format() joins those fields back (Node's `||` defaults). */
  export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  }
  export interface FormatInputPathObject {
    root?: string | undefined;
    dir?: string | undefined;
    base?: string | undefined;
    ext?: string | undefined;
    name?: string | undefined;
  }
  export function parse(path: string): ParsedPath;
  export function format(pathObject: FormatInputPathObject): string;
  /* The union @types/node declares: the bare module answers the TARGET
   * platform's value (a compile-time constant — "\\"/";" under a win32
   * triple, "/"/":" everywhere else). */
  export const sep: "\\" | "/";
  export const delimiter: ";" | ":";
  /* The platform-specific namespaces (real Node submodules too —
   * "node:path/posix" resolves). Each carries the FULL surface and
   * answers ITS platform's rules on any target, Node's own contract;
   * the bare module IS the target platform's implementation. */
  export const posix: typeof import("path/posix");
  export const win32: typeof import("path/win32");
}

declare module "node:path" {
  export * from "path";
}
