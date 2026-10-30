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
  scriptc types patch <package> <selector> <type> [--range <r>] [--dry-run]
                                            fix a wrong declaration of an installed
                                            package: shows what the selector
                                            matches and adds the type patch to
                                            package.json ("| undefined" widens)
  scriptc types list                        the project's type patches and what
                                            they match
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
      --fail-on <blockers|divergences|dynamic|dynamic-slots|node-islands|eager-node-islands|island-gaps>
                     coverage only: exit 1 when the entry path has blockers
                     (a build would fail), or also when it has Node
                     divergences, likely-hot functions that use untyped
                     values (SC6101), dynamic slots (SC6104), any Node
                     island (eager-node-islands is the same until deferred
                     evaluation lands), or a gap island (a package scriptc
                     should compile but cannot yet)
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
      --static       Linux: link the C library into the executable, which
                     then starts without the dynamic loader. glibc builds
                     need its static libraries (libc.a) on the build host
                     and refuse executables that include host, user or
                     group name lookups (opt in; --emit=exe only)
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
      --large-pages  Linux: at startup, move the executable's code onto 2 MiB
                     transparent huge pages when the system allows them, for
                     large programs. Takes about 3 ms per 10 MiB of code, and
                     all of the moved code stays resident (opt in; --emit=exe
                     only)
      --exceptions <common|rare>
                     Linux: how often the program throws (default: common).
                     rare lets recursive functions and functions near a
                     throw propagate exceptions by unwinding: their calls
                     need no exception check, and a throw that crosses them
                     costs a native unwind of several microseconds
      --target-cpu <baseline|x86-64-v2|x86-64-v3|x86-64-v4|native>
                     x86-64: compile the program's code for a CPU level
                     (default: baseline, which runs on any x86-64 CPU). The
                     executable then requires that level: v3 adds AVX2, BMI2
                     and FMA, v4 adds AVX-512. native uses the build host's
                     level. The runtime keeps its baseline code
      --cpu-dispatch x86-64: also compile the program's code for x86-64-v3
                     (AVX2), and run that copy on CPUs that support it. The
                     executable still runs on any x86-64 CPU. Not used with
                     --target-cpu above baseline. The SCRIPTC_CPU_LEVEL
                     environment variable (0 to 4, or a level name) caps the
                     level at run time (opt in; --emit=exe only)
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
                     optimized as without one, unless a .blocks file beside
                     the profile describes it. build prints how the profile
                     matched on stderr, and warns when more than 10% of the
                     functions it describes changed (release or speed;
                     --emit=exe only)
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
      --no-shape-overlay
                     compile npm packages' JavaScript without the types shape
                     inference proves (per package: "scriptc": {"packages":
                     {"<name>": {"shapes": false}}} in package.json)
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
      --node-islands <auto|explicit|off>
                     Node island policy (default: auto): npm packages outside
                     the native subset run in Node automatically; explicit
                     allows only marked islands; off allows none. REPORT-ONLY
                     in this version: coverage reports the islands a build
                     would choose; builds compile as before
      --node-island <pkg-or-path>
                     mark an npm package or one of your modules (a path or
                     glob) to run in a Node island (repeatable, comma lists;
                     report-only)
      --native <pkg> require an npm package to compile natively; outside the
                     native subset it is SC8003 (repeatable; report-only)
      --node <path>  the node executable Node islands use (report-only)
      --explain-island <pkg>
                     coverage only: why a package would run in a Node island,
                     with the first reason per module, the native import
                     sites and the packages inside its closure
      --strict-user-js
                     coverage only: report constructor functions, prototype
                     and shape mutation, sloppy-mode semantics and builtin
                     patching in your own .js/.cjs/.mjs modules as
                     SC8101–SC8105 blockers
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
  static: { type: "boolean", default: false },
  "windows-subsystem": { type: "string" },
  "detached-exit": { type: "boolean", default: false },
  libnode: { type: "string" },
  "large-pages": { type: "boolean", default: false },
  exceptions: { type: "string" },
  "target-cpu": { type: "string" },
  "cpu-dispatch": { type: "boolean" },
  "profile-generate": { type: "string" },
  "profile-use": { type: "string" },
  sparse: { type: "boolean", default: false },
  range: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  "keep-llvm": { type: "boolean", default: true },
  "emit-ir": { type: "boolean", default: false },
  sanitize: { type: "boolean", default: false },
  ffi: { type: "string" },
  "npm-static": { type: "string", multiple: true },
  "shape-overlay": { type: "boolean" },
  "provenance-sources": { type: "boolean", default: false },
  "external-types": { type: "string", multiple: true },
  tier: { type: "string" },
  "explain-dynamic": { type: "string" },
  "dynamic-tier-warning": { type: "boolean", default: true },
  wasm: { type: "string", multiple: true },
  "node-islands": { type: "string" },
  "node-island": { type: "string", multiple: true },
  native: { type: "string", multiple: true },
  node: { type: "string" },
  "explain-island": { type: "string" },
  "strict-user-js": { type: "boolean", default: false },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;
