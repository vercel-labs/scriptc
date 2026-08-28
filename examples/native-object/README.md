# External program object

This macOS arm64 example links a scriptc program object, a small C FFI
implementation, and the exact installed source runtime pack. It uses no
scriptc cache path.

```console
$ clang -target arm64-apple-macosx14.0.0 -O2 -c native.c -o native.o
$ scriptc build main.ts --ffi ffi.json --print=native-link-info -o app.o > link-info.json
$ node link.mjs cc link-info.json app-cc
$ ./app-cc
42
$ node link.mjs ld link-info.json app-ld
$ ./app-ld
42
```

`cc` uses the C compiler as a linker driver. `ld` compiles the same reported
runtime sources and invokes the Apple linker directly with the selected SDK.
The object defines `main`; it is a complete program object, not a library to
load into another process. Use `scriptc build --lib --profile ...` for a
host-callable static library.

The external object ABI is experimental. Always consume the runtime pack at
the exact `runtime_pack.version` reported by the same scriptc installation.
The object requires `scr_runtime_abi_v1`, so a mismatched runtime fails during
the link instead of starting with an incompatible ABI.
