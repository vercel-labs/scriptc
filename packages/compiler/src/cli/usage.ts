export const USAGE = `scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to an executable or source artifact
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --dynamic  what a --dynamic build compiles, and what still blocks it
  scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>
                                            type-resolve an embedder-provided module for analysis
  scriptc build --lib --profile <p.json>    library mode: compile the profile's entry
                                            module to a linkable static archive
                                            (<name>.lib.a), or a Wasm reactor
                                            (<name>.wasm) on wasm32-wasi,
                                            exporting the profile symbols; a profile
                                            with a sidecar section also gets the
                                            contract sidecar JSON beside the archive
  scriptc cache warm [runtime|tls|dynamic…] prebuild expensive native cache families
                                            for the current compiler/SDK/target

Options:
  -o, --out <path>   primary output path (default: .scriptc/<name><suffix>)
      --emit <kind>  primary output: ir, llvm, asm, obj, or exe
                     (default: exe). asm/obj use the matching platform helper
      --print <kind> print machine-readable metadata instead of the output path
                     (native-link-info implies --emit=obj and never links;
                     diagnostics prints the versioned JSON diagnostics
                     envelope for build and coverage)
      --fail-on <blockers|divergences>
                     coverage only: exit 1 when the entry path has blockers
                     (a build would fail), or also when it has Node
                     divergences
      --backend <b>  code generator (llvm)
      --optimization <release|dev|speed>
                     native optimization posture (default: release/-O2). dev
                     uses -O0, source breakpoints, and cached LLVM object shards;
                     macOS executable builds also produce an adjacent .dSYM.
                     speed trades larger executables and longer builds for
                     faster programs (runtime inlining, inline reference
                     counting, cache-line-aligned runtime code on x86-64)
      --strip        remove symbol/debug payload from the linked executable
                     for smaller builds (opt in; --emit=exe only)
      --windows-subsystem <console|gui>
                     Windows executable subsystem (default: console). gui
                     prevents Windows from opening a console window
      --keep-llvm    keep generated LLVM IR beside the executable (default)
      --no-keep-llvm delete generated LLVM IR after compiling
      --emit-ir      also write IR beside an executable or library archive;
                     deprecated for executables: use --emit=ir for primary IR
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
  emit: { type: "string" },
  print: { type: "string" },
  "fail-on": { type: "string" },
  backend: { type: "string" },
  optimization: { type: "string" },
  strip: { type: "boolean", default: false },
  "windows-subsystem": { type: "string" },
  "keep-llvm": { type: "boolean", default: true },
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
