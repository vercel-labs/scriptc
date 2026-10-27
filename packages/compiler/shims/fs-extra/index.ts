// scriptc's built-in implementation of the `fs-extra` package, 8.x-11.x API.
//
// Programs whose installed fs-extra is 8.x through 11.x compile this module
// in its place (see packages/compiler/src/frontend/package-shims.ts), and its
// declarations stand in for @types/fs-extra. The default import, the
// namespace import and named imports all read the same exports, as they read
// fs-extra's single CommonJS export object under Node.
export * from "./core/api.ts";
export * as default from "./core/api.ts";
