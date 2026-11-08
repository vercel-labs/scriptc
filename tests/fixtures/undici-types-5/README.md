# undici-types 5 fixture

`undici-types/` is the published package `undici-types` 5.26.5, unchanged (npm tarball sha256 `503bffdea1bee0526fb2ac75a4ac01ee5e712f251fabdeb8da4b408a519ed465`, MIT). It is COMMITTED TEST DATA, pinned so the declarations never drift with the registry.

`@types/node` 20 builds the types of the global `fetch` from this package, so in a project on those Node types the `dispatcher` of the global `RequestInit` is this package's `Dispatcher`. Its `HttpMethod` is the closed list of nine names, as in every `undici-types` before 7 (7 also admits any other string).

`packages/compiler/test/undici-shim-types.test.ts` checks that such a dispatcher is accepted where a program names the `undici` package's own `Dispatcher`, against the real undici 5 declarations and against scriptc's built-in undici.
