export const USAGE = `scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to an executable target artifact
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --dynamic  what a --dynamic build compiles, and what still blocks it
  scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>
                                            type-resolve an embedder-provided module for analysis
  scriptc build --lib --profile <p.json>    library mode: compile the profile's entry
                                            module to a linkable static archive
                                            (<name>.lib.a) exporting the
                                            profile-declared C symbols; a profile
                                            with a sidecar section also gets the
                                            contract sidecar JSON beside the archive
  scriptc cache warm [runtime|tls|dynamic…] prebuild expensive native cache families
                                            for the current compiler/SDK/target

Options:
  -o, --out <path>   output path (default: .scriptc/<name>[.exe|.wasm])
      --backend <b>  code generator. llvm is the default and the output that
                     ships; c emits readable C for inspecting what the
                     compiler produced, and program behavior is identical
                     either way. On native targets, a program outside the LLVM tier still
                     builds — the default lane emits C for it and a one-line
                     stderr note names the construct — while an explicit
                     --backend llvm fails with that construct named
                     wasm32-wasi is LLVM-only unless --backend c is explicit;
                     its C inspection lane accepts async-free programs only
      --optimization <release|dev>
                     native optimization posture (default: release/-O2). dev
                     uses -O0 and stable cached LLVM object shards for faster
                     edits of large programs
      --from-c       treat input as a C (or .ll) file (toolchain plumbing/debugging)
      --keep-c       keep the generated program TU next to the executable
                     (default; the .ll — or the .c under --backend=c or
                     when the build fell back)
      --no-keep-c    delete the generated program TU after compiling
      --emit-ir      also write the IR as JSON next to the executable
      --sanitize     build with ASan + runtime RC audit
      --dynamic      embed the dynamic engine (adds ~620KB; static stays the default)
      --ffi <file>   bind signature-only TypeScript declarations to native
                     C symbols and link the manifest's archives/libraries
      --npm-static <pkg[,pkg…]|auto>
                     compile the named npm packages' shipped JS statically as
                     program modules (repeatable; "auto" opts in every eligible
                     direct import: own .d.ts, unminified JS, no build-transform
                     markers). A package preflight refuses falls back to the
                     island (--dynamic) with a coverage-report note — opt-in,
                     experimental
      --provenance-sources
                     EXPERIMENTAL: compile npm dependencies from their
                     provenance-attested SOURCE (fetched at the attested
                     commit) as static program modules; packages without a
                     usable attestation keep the island path (a note, never
                     a failure)
      --external-types <specifier=file.d.ts>
                     coverage only: map an exact bare module specifier to a
                     local declaration file. The declaration supplies types
                     for analysis; the host module remains an explicit
                     external-boundary blocker (repeatable)
  -h, --help         show this help
  -v, --version      print the version
`;

export const CLI_OPTIONS = {
  out: { type: "string", short: "o" },
  backend: { type: "string" },
  optimization: { type: "string" },
  "from-c": { type: "boolean", default: false },
  "keep-c": { type: "boolean", default: true },
  "emit-ir": { type: "boolean", default: false },
  sanitize: { type: "boolean", default: false },
  dynamic: { type: "boolean", default: false },
  ffi: { type: "string" },
  "npm-static": { type: "string", multiple: true },
  "provenance-sources": { type: "boolean", default: false },
  "external-types": { type: "string", multiple: true },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;
