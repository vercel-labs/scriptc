export const USAGE = `scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to an executable or source artifact
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>
                                            type-resolve an embedder-provided module for analysis
  scriptc build --lib --profile <p.json>    library mode: compile the profile's entry
                                            module to a linkable static archive
                                            (<name>.lib.a), or a Wasm reactor
                                            (<name>.wasm) on wasm32-wasi,
                                            exporting the profile symbols; a profile
                                            with a sidecar section also gets the
                                            contract sidecar JSON beside the archive
  scriptc cache warm [runtime|tls…] verify and load precompiled runtime families
                                            for the current compiler/SDK/target
  scriptc merge-profiles -o <out.profdata> [--sparse] <profile…>
                                            merge the raw profiles that
                                            --profile-generate runs wrote (or
                                            earlier merged profiles) into one
                                            profile for --profile-use;
                                            --sparse leaves out functions
                                            that never ran (a smaller file)

Options:
  -o, --out <path>   primary output path (default: .scriptc/<name><suffix>)
      --emit <kind>  primary output: ir, llvm, asm, obj, or exe
                     (default: exe). asm/obj use the matching platform helper
      --print <kind> print machine-readable metadata instead of the output path
                     (native-link-info implies --emit=obj and never links;
                     diagnostics prints the versioned JSON diagnostics
                     envelope for build and coverage)
      --fail-on <blockers|divergences|dynamic>
                     coverage only: exit 1 when the entry path has blockers
                     (a build would fail), or also when it has Node
                     divergences, or also when it has likely-hot functions
                     that use untyped values (SC6101)
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
      --detached-exit
                     Linux: after process.exit, free the program's memory in
                     a helper process so the parent sees the exit sooner. The
                     helper keeps the executable mapped and its memory charged
                     for up to ~100 ms after exit (opt in; --emit=exe only)
      --libnode <dir|beside>
                     the libnode pack that calls into Node.js (@scriptc/node)
                     load at run time, or beside to copy it next to the
                     executable (default: SCRIPTC_LIBNODE at build time;
                     SCRIPTC_LIBNODE overrides it at run time)
      --target-cpu <baseline|x86-64-v2|x86-64-v3|x86-64-v4|native>
                     x86-64: compile the program's code for a CPU level
                     (default: baseline, which runs on any x86-64 CPU). The
                     executable then requires that level: v3 adds AVX2, BMI2
                     and FMA, v4 adds AVX-512. native uses the build host's
                     level. The runtime keeps its baseline code
      --profile-generate <pattern>
                     Linux: instrument the executable for profile-guided
                     optimization. Each run writes a raw profile to the
                     pattern (%p expands to the process id; the
                     LLVM_PROFILE_FILE environment variable overrides it).
                     Instrumented programs run slower (--emit=exe only)
      --profile-use <file.profdata>
                     optimize with a merged profile (scriptc merge-profiles):
                     code is laid out, inlined and split by how the profiled
                     runs used it. Code the profile does not describe, or
                     describes from an older version of the program, is
                     optimized as without one (release or speed; --emit=exe
                     only)
      --keep-llvm    keep generated LLVM IR beside the executable (default)
      --no-keep-llvm delete generated LLVM IR after compiling
      --emit-ir      also write IR beside an executable or library archive;
                     deprecated for executables: use --emit=ir for primary IR
      --sanitize     build with ASan + runtime RC audit
      --ffi <file>   bind signature-only TypeScript declarations to native
                     C symbols and link the manifest's archives/libraries
      --npm-static <pkg[,pkg…]|auto>
                     compile the named npm packages' shipped JS statically as
                     program modules (repeatable; "auto" opts in every eligible
                     direct import: own .d.ts, no build-transform markers;
                     "pkg..." also names every package pkg depends on).
                     Packages that fail preflight are refused with a
                     diagnostic. Eligible dependencies compile automatically.
      --provenance-sources
                     EXPERIMENTAL: compile npm dependencies from their
                     provenance-attested SOURCE (fetched at the attested
                     commit) as static program modules; packages without a
                     usable attestation use their published source
      --external-types <specifier=file.d.ts>
                     coverage only: map an exact bare module specifier to a
                     local declaration file. The declaration supplies types
                     for analysis; the host module remains an explicit
                     external-boundary blocker (repeatable)
      --tier <auto|static-only>
                     tier policy (default: auto). static-only keeps every
                     construct without a static lowering a compile error, so
                     the program has no dynamic-tier demotions. Both modes
                     currently compile identically
      --explain-dynamic[=<name>]
                     coverage only: list the functions that operate on dynamic
                     values and the bindings, fields, functions, classes and
                     modules the dynamic tier would take over, with the
                     refusal behind each; a name shows only that unit's chain
      --no-dynamic-tier-warning
                     build and coverage: leave out SC6101, the warning that
                     names likely-hot functions that use untyped values
      --wasm <file.wasm>
                     coverage only: report a WebAssembly module the program
                     loads whose path its sources do not spell (repeatable;
                     modules the sources name, inline modules and packaged
                     .wasm files are found without it)
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
  "detached-exit": { type: "boolean", default: false },
  libnode: { type: "string" },
  "target-cpu": { type: "string" },
  "profile-generate": { type: "string" },
  "profile-use": { type: "string" },
  sparse: { type: "boolean", default: false },
  "keep-llvm": { type: "boolean", default: true },
  "emit-ir": { type: "boolean", default: false },
  sanitize: { type: "boolean", default: false },
  ffi: { type: "string" },
  "npm-static": { type: "string", multiple: true },
  "provenance-sources": { type: "boolean", default: false },
  "external-types": { type: "string", multiple: true },
  tier: { type: "string" },
  "explain-dynamic": { type: "string" },
  "dynamic-tier-warning": { type: "boolean", default: true },
  wasm: { type: "string", multiple: true },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;
