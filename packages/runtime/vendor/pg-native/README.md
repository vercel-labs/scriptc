# pg-native — the `.node` limitation, and the honest fallback

`pg` ships an OPTIONAL native accelerator, `pg-native` (npm), loaded at
runtime through `require('pg-native')` → a compiled Node N-API addon
(`build/Release/*.node`, a `dlopen`-able shared object). This document
records why that load cannot work inside a compiled scriptc binary, what
the runtime does instead, and what the honest fallback is.

## Why the `.node` addon cannot load

1. **No N-API host.** A compiled scriptc binary embeds the static runtime
   (`packages/runtime/src/scr_*.c`) — there is no Node, no V8, and no
   N-API ABI in the process. `pg-native`'s addon exports
   `napi_register_module_v1` and speaks the N-API calling convention on
   every boundary; without a host implementing that ABI the entry point
   has nothing to register into.
2. **No dynamic loader surface.** The static tier links whole-program
   archives at build time (`posix_spawnp`, sockets, and the vendored
   mbedTLS/zlib/curl objects are compiled in). The runtime's FFI slice
   (`scr_ffi.c`) is a C-ABI surface for the COMPILED program's own
   declarations — it never `dlopen`s arbitrary `.node` files, and the
   frontend deliberately fences dynamic module graphs (a compiled
   binary's module graph is fixed at build).
3. **Module-graph timing.** `pg` probes `pg-native` lazily on
   `pg.native` first access. In a compiled binary the npm-static graph
   is resolved at build; a `require('pg-native')` that nothing can
   satisfy must not be silently dropped — the honest answer is the
   SC2030-family diagnostic (unresolvable import → named fence), not a
   runtime trap.

## The fallback (and why it is faithful)

`pg-native` is a pure ACCELERATOR: synchronous libpq bindings behind
`Client`'s optional `native` mode. Plain `pg` (the JS protocol client,
TCP or Unix socket) is the default for every Node program that never
opts in, and it is the runtime's supported surface: the compiled
program drives the same wire protocol (`Query`, `Bind`, TLS via the
vendored mbedTLS stack) over the runtime's socket slice. Programs that
need `pg` compile with the JS client and no source changes — `pg.native`
accesses are the one fenced shape, reported at build with a named
diagnostic instead of a broken binary.

## What would change this

A static `libpq` could in principle be vendored and linked the way
mbedTLS is (C ABI, no host needed), with a `scr_pg_*` raw slice in the
runtime. That is a deliberate vendor-onboarding decision (license,
build matrix, security surface), not a `.node` shim — `dlopen` of
N-API addons remains impossible without embedding a Node host.
