// Library-mode npm posture fixture (static-or-refuse): a bare specifier
// naming an ELIGIBLE package (own .d.ts, no
// build-transform markers) compiles statically as part of the library
// graph — no flag, no island — and the package's own top-level require
// ("mathdep") joins through the same bar. The node:path import alongside
// pins the builtin story: an async_free builtin keeps working under the
// npm posture, governed by SC4005 alone.
import { OFFSET, scale } from "mathkit";
import { basename } from "node:path";

export function scaled(x: number): number {
  return scale(x, 3) + OFFSET;
}

export function tail(p: string): string {
  return basename(p);
}

console.log("npm-static ready");
