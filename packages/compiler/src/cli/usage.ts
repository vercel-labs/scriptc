/** The scriptc command line's commands and options. `CLI_OPTIONS` configures the argument
 * parser, `CLI_OPTION_DOCS` and `CLI_COMMANDS` describe every option and command, and the help
 * text and the MCP tools are both generated from these tables. */

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
  "stdout-buffering": { type: "boolean", default: false },
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
  "emit-lowered": { type: "string" },
  "from-lowered": { type: "string" },
  "from-lowered-accept": { type: "string", multiple: true },
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
  "node-island-decision": { type: "string" },
  native: { type: "string", multiple: true },
  node: { type: "string" },
  "explain-island": { type: "string" },
  "strict-user-js": { type: "boolean", default: false },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

/** A command-line option, named as `parseArgs` and `--<name>` spell it. */
export type CliOptionName = keyof typeof CLI_OPTIONS;

/** A term in the help text, such as a flag or a command's syntax, and the lines that explain it. */
export interface CliHelpEntry {
  readonly term: string;
  readonly help: readonly string[];
}

/** How the help documents an option. `entries` are its lines in the Options section. An option
 * that only a command's usage line names has no entries, and `summary` says what it does. */
export interface CliOptionDoc {
  readonly entries: readonly CliHelpEntry[];
  readonly summary?: string;
}

/** Every option's documentation, in the order the Options section lists them; `satisfies`
 * makes the compiler require one entry per option. */
export const CLI_OPTION_DOCS: Readonly<Record<string, CliOptionDoc>> = {
  out: {
    entries: [
      {
        term: "-o, --out <path>",
        help: ["primary output path (default: .scriptc/<name><suffix>)"],
      },
    ],
  },
  emit: {
    entries: [
      {
        term: "--emit <kind>",
        help: [
          "primary output: ir, llvm, asm, obj, or exe",
          "(default: exe). asm/obj use the matching platform helper",
        ],
      },
    ],
  },
  print: {
    entries: [
      {
        term: "--print <kind>",
        help: [
          "print machine-readable metadata instead of the output path",
          "(native-link-info implies --emit=obj and never links;",
          "diagnostics prints the versioned JSON diagnostics",
          "envelope for build and coverage)",
        ],
      },
    ],
  },
  "fail-on": {
    entries: [
      {
        term: "--fail-on <blockers|divergences|dynamic|dynamic-slots|node-islands|eager-node-islands|island-gaps>",
        help: [
          "coverage only: exit 1 when the entry path has blockers",
          "(a build would fail), or also when it has Node",
          "divergences, likely-hot functions that use untyped",
          "values (SC6101), dynamic slots (SC6104), any Node",
          "island (eager-node-islands is the same until deferred",
          "evaluation lands), or a gap island (a package scriptc",
          "should compile but cannot yet)",
        ],
      },
    ],
  },
  backend: { entries: [{ term: "--backend <b>", help: ["code generator (llvm)"] }] },
  optimization: {
    entries: [
      {
        term: "--optimization <release|dev|speed>",
        help: [
          "native optimization posture (default: release/-O2). dev",
          "uses -O0, source breakpoints, and cached LLVM object shards;",
          "macOS executable builds also produce an adjacent .dSYM.",
          "speed trades larger executables and longer builds for",
          "faster programs (runtime inlining, inline reference",
          "counting, cache-line-aligned runtime code on x86-64)",
        ],
      },
    ],
  },
  strip: {
    entries: [
      {
        term: "--strip",
        help: [
          "remove symbol/debug payload from the linked executable",
          "for smaller builds (opt in; --emit=exe only)",
        ],
      },
    ],
  },
  static: {
    entries: [
      {
        term: "--static",
        help: [
          "Linux: link the C library into the executable, which",
          "then starts without the dynamic loader. glibc builds",
          "need its static libraries (libc.a) on the build host",
          "and refuse executables that include host, user or",
          "group name lookups (opt in; --emit=exe only)",
        ],
      },
    ],
  },
  "windows-subsystem": {
    entries: [
      {
        term: "--windows-subsystem <console|gui>",
        help: [
          "Windows executable subsystem (default: console). gui",
          "prevents Windows from opening a console window",
        ],
      },
    ],
  },
  "detached-exit": {
    entries: [
      {
        term: "--detached-exit",
        help: [
          "Linux: after process.exit, free the program's memory in",
          "a helper process so the parent sees the exit sooner. The",
          "helper keeps the executable mapped and its memory charged",
          "for up to ~100 ms after exit (opt in; --emit=exe only)",
        ],
      },
    ],
  },
  "stdout-buffering": {
    entries: [
      {
        term: "--stdout-buffering",
        help: [
          "keep console and process stdout bytes in a 64 KiB buffer",
          "when stdout is not a terminal, for programs that print",
          "many lines. A terminal keeps one write per call. The",
          "buffer settles when it fills, before stderr, when the",
          "event loop sleeps, before a blocking stdin read, on",
          "process.kill and process.exit, and at exit; a crash such",
          "as SIGKILL can lose up to 64 KiB (experimental; opt in;",
          "--emit=exe only)",
        ],
      },
    ],
  },
  libnode: {
    entries: [
      {
        term: "--libnode <dir|beside>",
        help: [
          "the libnode pack that calls into Node.js (@scriptc/node)",
          "load at run time, or beside to copy it next to the",
          "executable (default: SCRIPTC_LIBNODE at build time;",
          "SCRIPTC_LIBNODE overrides it at run time)",
        ],
      },
    ],
  },
  "large-pages": {
    entries: [
      {
        term: "--large-pages",
        help: [
          "Linux: at startup, move the executable's code onto 2 MiB",
          "transparent huge pages when the system allows them, for",
          "large programs. Takes about 3 ms per 10 MiB of code, and",
          "all of the moved code stays resident (opt in; --emit=exe",
          "only)",
        ],
      },
    ],
  },
  exceptions: {
    entries: [
      {
        term: "--exceptions <common|rare>",
        help: [
          "Linux: how often the program throws (default: common).",
          "rare lets recursive functions and functions near a",
          "throw propagate exceptions by unwinding: their calls",
          "need no exception check, and a throw that crosses them",
          "costs a native unwind of several microseconds",
        ],
      },
    ],
  },
  "target-cpu": {
    entries: [
      {
        term: "--target-cpu <baseline|x86-64-v2|x86-64-v3|x86-64-v4|native>",
        help: [
          "x86-64: compile the program's code for a CPU level",
          "(default: baseline, which runs on any x86-64 CPU). The",
          "executable then requires that level: v3 adds AVX2, BMI2",
          "and FMA, v4 adds AVX-512. native uses the build host's",
          "level. The runtime keeps its baseline code",
        ],
      },
    ],
  },
  "cpu-dispatch": {
    entries: [
      {
        term: "--cpu-dispatch",
        help: [
          "x86-64: also compile the program's code for x86-64-v3",
          "(AVX2), and run that copy on CPUs that support it. The",
          "executable still runs on any x86-64 CPU. Not used with",
          "--target-cpu above baseline. The SCRIPTC_CPU_LEVEL",
          "environment variable (0 to 4, or a level name) caps the",
          "level at run time (opt in; --emit=exe only)",
        ],
      },
    ],
  },
  "profile-generate": {
    entries: [
      {
        term: "--profile-generate <pattern>",
        help: [
          "Linux: instrument the executable for profile-guided",
          "optimization. Each run writes a raw profile to the",
          "pattern (%p expands to the process id; the",
          "LLVM_PROFILE_FILE environment variable overrides it).",
          "Instrumented programs run slower (--emit=exe only)",
        ],
      },
    ],
  },
  "profile-use": {
    entries: [
      {
        term: "--profile-use <file.profdata>",
        help: [
          "optimize with a merged profile (scriptc merge-profiles):",
          "code is laid out, inlined and split by how the profiled",
          "runs used it. Code the profile does not describe, or",
          "describes from an older version of the program, is",
          "optimized as without one, unless a .blocks file beside",
          "the profile describes it. build prints how the profile",
          "matched on stderr, and warns when more than 10% of the",
          "functions it describes changed (release or speed;",
          "--emit=exe only)",
        ],
      },
    ],
  },
  "keep-llvm": {
    entries: [
      { term: "--keep-llvm", help: ["keep generated LLVM IR beside the executable (default)"] },
      { term: "--no-keep-llvm", help: ["delete generated LLVM IR after compiling"] },
    ],
  },
  "emit-ir": {
    entries: [
      {
        term: "--emit-ir",
        help: [
          "also write IR beside an executable or library archive;",
          "deprecated for executables: use --emit=ir for primary IR",
        ],
      },
    ],
  },
  "emit-lowered": {
    entries: [
      {
        term: "--emit-lowered <file>",
        help: [
          "compiler development: also write the lowered program",
          "(the IR the frontend hands the backend, with its",
          "sources, warnings and the inputs it was lowered from)",
          "to the file (build only)",
        ],
      },
    ],
  },
  "from-lowered": {
    entries: [
      {
        term: "--from-lowered <file>",
        help: [
          "compiler development: build from a file --emit-lowered",
          "wrote instead of running the frontend. The build is",
          "refused when the compiler, the options or an input",
          "differ from the ones the file records (build only)",
        ],
      },
    ],
  },
  "from-lowered-accept": {
    entries: [
      {
        term: "--from-lowered-accept <kind[,kind…]>",
        help: [
          "build from the file although the named kinds differ",
          "(compiler, options, inputs); each difference is",
          "reported on stderr (repeatable)",
        ],
      },
    ],
  },
  sanitize: { entries: [{ term: "--sanitize", help: ["build with ASan + runtime RC audit"] }] },
  ffi: {
    entries: [
      {
        term: "--ffi <file>",
        help: [
          "bind signature-only TypeScript declarations to native",
          "C symbols and link the manifest's archives/libraries",
        ],
      },
    ],
  },
  "npm-static": {
    entries: [
      {
        term: "--npm-static <pkg[,pkg…]|auto>",
        help: [
          "compile the named npm packages' shipped JS statically as",
          'program modules (repeatable; "auto" opts in every eligible',
          "direct import: own .d.ts, no build-transform markers;",
          '"pkg..." also names every package pkg depends on).',
          "Packages that fail preflight are refused with a",
          "diagnostic. Eligible dependencies compile automatically.",
        ],
      },
    ],
  },
  "shape-overlay": {
    entries: [
      {
        term: "--no-shape-overlay",
        help: [
          "compile npm packages' JavaScript without the types shape",
          'inference proves (per package: "scriptc": {"packages":',
          '{"<name>": {"shapes": false}}} in package.json)',
        ],
      },
    ],
  },
  "provenance-sources": {
    entries: [
      {
        term: "--provenance-sources",
        help: [
          "EXPERIMENTAL: compile npm dependencies from their",
          "provenance-attested SOURCE (fetched at the attested",
          "commit) as static program modules; packages without a",
          "usable attestation use their published source",
        ],
      },
    ],
  },
  "external-types": {
    entries: [
      {
        term: "--external-types <specifier=file.d.ts>",
        help: [
          "coverage only: map an exact bare module specifier to a",
          "local declaration file. The declaration supplies types",
          "for analysis; the host module remains an explicit",
          "external-boundary blocker (repeatable)",
        ],
      },
    ],
  },
  tier: {
    entries: [
      {
        term: "--tier <auto|static-only>",
        help: [
          "tier policy (default: auto). static-only keeps every",
          "construct without a static lowering a compile error, so",
          "the program has no dynamic-tier demotions; auto compiles",
          "such a construct in the dynamic tier where it can",
        ],
      },
    ],
  },
  "explain-dynamic": {
    entries: [
      {
        term: "--explain-dynamic[=<name>]",
        help: [
          "coverage only: list the functions that operate on dynamic",
          "values and the bindings, fields, functions, classes and",
          "modules the dynamic tier would take over, with the",
          "refusal behind each; a name shows only that unit's chain",
        ],
      },
    ],
  },
  "dynamic-tier-warning": {
    entries: [
      {
        term: "--no-dynamic-tier-warning",
        help: [
          "build and coverage: leave out SC6101, the warning that",
          "names likely-hot functions that use untyped values",
        ],
      },
    ],
  },
  "node-islands": {
    entries: [
      {
        term: "--node-islands <auto|explicit|off>",
        help: [
          "Node island policy (default: auto): npm packages outside",
          "the native subset run in Node automatically; explicit",
          "allows only marked islands; off allows none. REPORT-ONLY",
          "in this version: coverage reports the islands a build",
          "would choose; builds compile as before",
        ],
      },
    ],
  },
  "node-island": {
    entries: [
      {
        term: "--node-island <pkg-or-path>",
        help: [
          "mark an npm package (its name, whatever it looks like:",
          "highlight.js is a package) or one of your modules (a",
          "path or glob; ./file.js is always a file) to run in a",
          "Node island (repeatable, comma lists; report-only)",
        ],
      },
    ],
  },
  "node-island-decision": {
    entries: [
      {
        term: "--node-island-decision <file>",
        help: [
          "keep the Node island decision this build reaches in the",
          "file, and start from it when the file exists: a large",
          "program then decides its islands in one round instead of",
          "several. A package that newly needs an island still gets",
          "one and the file is updated; one that no longer needs its",
          "island keeps it until the file is deleted",
        ],
      },
    ],
  },
  native: {
    entries: [
      {
        term: "--native <pkg>",
        help: [
          "require an npm package to compile natively; outside the",
          "native subset it is SC8003 (repeatable; report-only)",
        ],
      },
    ],
  },
  node: {
    entries: [
      { term: "--node <path>", help: ["the node executable Node islands use (report-only)"] },
    ],
  },
  "explain-island": {
    entries: [
      {
        term: "--explain-island <pkg>",
        help: [
          "coverage only: why a package would run in a Node island,",
          "with the first reason per module, the native import",
          "sites and the packages inside its closure",
        ],
      },
    ],
  },
  "strict-user-js": {
    entries: [
      {
        term: "--strict-user-js",
        help: [
          "coverage only: report constructor functions, prototype",
          "and shape mutation, sloppy-mode semantics and builtin",
          "patching in your own .js/.cjs/.mjs modules as",
          "SC8101–SC8105 blockers",
        ],
      },
    ],
  },
  wasm: {
    entries: [
      {
        term: "--wasm <file.wasm>",
        help: [
          "coverage only: report a WebAssembly module the program",
          "loads whose path its sources do not spell (repeatable;",
          "modules the sources name, inline modules and packaged",
          ".wasm files are found without it)",
        ],
      },
    ],
  },
  help: { entries: [{ term: "-h, --help", help: ["show this help"] }] },
  version: { entries: [{ term: "-v, --version", help: ["print the version"] }] },
  sparse: { entries: [], summary: "leave out functions that never ran, for a smaller file" },
  range: {
    entries: [],
    summary: "the version range the patch applies to (default: ^<installed version>)",
  },
  "dry-run": { entries: [], summary: "print what the selector matches without writing the patch" },
  lib: { entries: [], summary: "compile a library instead of an executable" },
  profile: {
    entries: [],
    summary: "the library profile, which names the entry module and the exported symbols",
  },
} satisfies { readonly [Name in CliOptionName]: CliOptionDoc };

/** A positional argument of a command. */
export interface CliPositional {
  readonly name: string;
  readonly summary: string;
  readonly required: boolean;
  readonly variadic: boolean;
}

/** The strongest effect a command can have: read files, write files, or execute the program it
 * compiles. */
export type CliCommandEffect = "read" | "write" | "execute";

/** A command: the arguments that select it, its help, and the positionals and options it takes. */
export interface CliCommand {
  /** The command's words joined by hyphens, such as `types-patch`. */
  readonly name: string;
  /** The leading arguments that select the command. */
  readonly argv: readonly string[];
  readonly usage: readonly CliHelpEntry[];
  readonly positionals: readonly CliPositional[];
  readonly options: readonly CliOptionName[];
  readonly requiredOptions: readonly CliOptionName[];
  /** Whether `--print=diagnostics` makes the command write the JSON diagnostics envelope. */
  readonly diagnostics: boolean;
  readonly effect: CliCommandEffect;
}

const ENTRY: CliPositional = {
  name: "file",
  summary: "the TypeScript or JavaScript entry file (.ts, .mts, .cts, .js, .mjs or .cjs)",
  required: true,
  variadic: false,
};

const NODE_ISLAND_OPTIONS: readonly CliOptionName[] = [
  "node-islands",
  "node-island",
  "native",
  "node",
];

const EXECUTABLE_OPTIONS: readonly CliOptionName[] = [
  "out",
  "emit",
  "backend",
  "optimization",
  "strip",
  "static",
  "windows-subsystem",
  "detached-exit",
  "stdout-buffering",
  "libnode",
  "large-pages",
  "exceptions",
  "target-cpu",
  "cpu-dispatch",
  "profile-generate",
  "profile-use",
  "keep-llvm",
  "emit-ir",
  "sanitize",
  "ffi",
  "npm-static",
  "shape-overlay",
  "provenance-sources",
  "tier",
  "dynamic-tier-warning",
  ...NODE_ISLAND_OPTIONS,
  "node-island-decision",
];

/** Every command, in the order the help lists them. */
export const CLI_COMMANDS: readonly CliCommand[] = [
  {
    name: "build",
    argv: ["build"],
    usage: [
      {
        term: "scriptc build <file.ts|.js> [options]",
        help: ["compile to an executable or source artifact"],
      },
    ],
    positionals: [ENTRY],
    options: [
      ...EXECUTABLE_OPTIONS,
      "print",
      "emit-lowered",
      "from-lowered",
      "from-lowered-accept",
    ],
    requiredOptions: [],
    diagnostics: true,
    effect: "write",
  },
  {
    name: "run",
    argv: ["run"],
    usage: [{ term: "scriptc run <file.ts|.js> [options]", help: ["compile and run"] }],
    positionals: [ENTRY],
    options: EXECUTABLE_OPTIONS,
    requiredOptions: [],
    diagnostics: false,
    effect: "execute",
  },
  {
    name: "coverage",
    argv: ["coverage"],
    usage: [
      {
        term: "scriptc coverage <file.ts|.js>",
        help: ["how much compiles statically, and why not"],
      },
      {
        term: "scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>",
        help: ["type-resolve an embedder-provided module for analysis"],
      },
    ],
    positionals: [ENTRY],
    options: [
      "print",
      "fail-on",
      "ffi",
      "npm-static",
      "provenance-sources",
      "external-types",
      "tier",
      "explain-dynamic",
      "dynamic-tier-warning",
      ...NODE_ISLAND_OPTIONS,
      "explain-island",
      "strict-user-js",
      "wasm",
    ],
    requiredOptions: [],
    diagnostics: true,
    effect: "read",
  },
  {
    name: "build-lib",
    argv: ["build", "--lib"],
    usage: [
      {
        term: "scriptc build --lib --profile <p.json>",
        help: [
          "library mode: compile the profile's entry",
          "module to a linkable static archive",
          "(<name>.lib.a), or a Wasm reactor",
          "(<name>.wasm) on wasm32-wasi,",
          "exporting the profile symbols; a profile",
          "with a sidecar section also gets the",
          "contract sidecar JSON beside the archive",
        ],
      },
    ],
    positionals: [],
    options: ["profile", "out", "emit-ir", "sanitize", "keep-llvm"],
    requiredOptions: ["profile"],
    diagnostics: false,
    effect: "write",
  },
  {
    name: "types-patch",
    argv: ["types", "patch"],
    usage: [
      {
        term: "scriptc types patch <package> <selector> <type> [--range <r>] [--dry-run]",
        help: [
          "fix a wrong declaration of an installed",
          "package: shows what the selector",
          "matches and adds the type patch to",
          'package.json ("| undefined" widens)',
        ],
      },
    ],
    positionals: [
      {
        name: "package",
        summary: "the installed package to patch",
        required: true,
        variadic: false,
      },
      {
        name: "selector",
        summary: "the declaration to patch, such as HelpContext.helpWidth",
        required: true,
        variadic: false,
      },
      {
        name: "type",
        summary: "the corrected type; a type starting with | widens the declared one",
        required: true,
        variadic: false,
      },
    ],
    options: ["range", "dry-run"],
    requiredOptions: [],
    diagnostics: false,
    effect: "write",
  },
  {
    name: "types-list",
    argv: ["types", "list"],
    usage: [
      { term: "scriptc types list", help: ["the project's type patches and what", "they match"] },
    ],
    positionals: [],
    options: [],
    requiredOptions: [],
    diagnostics: false,
    effect: "read",
  },
  {
    name: "cache-warm",
    argv: ["cache", "warm"],
    usage: [
      {
        term: "scriptc cache warm [runtime|tls…]",
        help: [
          "verify and load precompiled runtime families",
          "for the current compiler/SDK/target",
        ],
      },
    ],
    positionals: [
      {
        name: "profiles",
        summary: "the runtime families to warm, runtime or tls (default: all)",
        required: false,
        variadic: true,
      },
    ],
    options: ["optimization", "sanitize"],
    requiredOptions: [],
    diagnostics: false,
    effect: "write",
  },
  {
    name: "merge-profiles",
    argv: ["merge-profiles"],
    usage: [
      {
        term: "scriptc merge-profiles -o <out.profdata> [--sparse] <profile…>",
        help: [
          "merge the raw profiles that",
          "--profile-generate runs wrote (or",
          "earlier merged profiles) into one",
          "profile for --profile-use;",
          "--sparse leaves out functions",
          "that never ran (a smaller file)",
        ],
      },
    ],
    positionals: [
      {
        name: "profiles",
        summary: "the raw profiles that --profile-generate runs wrote, or earlier merged profiles",
        required: true,
        variadic: true,
      },
    ],
    options: ["out", "sparse"],
    requiredOptions: ["out"],
    diagnostics: false,
    effect: "write",
  },
];

const USAGE_HELP_COLUMN = 44;
const OPTION_HELP_COLUMN = 21;

/** Renders help entries as a definition list: the term, indented further when it is a long-only
 * flag, then its help from `column` on, starting on the term's line when the term leaves room. */
function renderEntries(entries: readonly CliHelpEntry[], column: number): string {
  let text = "";
  for (const entry of entries) {
    const term = (entry.term.startsWith("--") ? "      " : "  ") + entry.term;
    const [first, ...rest] = entry.help;
    const lines =
      first !== undefined && term.length < column
        ? [term.padEnd(column) + first]
        : [term, ...(first === undefined ? [] : [" ".repeat(column) + first])];
    for (const line of rest) lines.push(" ".repeat(column) + line);
    text += lines.join("\n") + "\n";
  }
  return text;
}

/** `scriptc mcp`, which serves the commands above and so is not one of `CLI_COMMANDS`. */
const MCP_USAGE: CliHelpEntry = {
  term: "scriptc mcp",
  help: ["serve these commands as MCP tools over stdio"],
};

/** The `--help` text. */
export const USAGE =
  "scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)\n\nUsage:\n" +
  renderEntries(
    [...CLI_COMMANDS.flatMap((command) => command.usage), MCP_USAGE],
    USAGE_HELP_COLUMN,
  ) +
  "\nOptions:\n" +
  renderEntries(
    Object.values(CLI_OPTION_DOCS).flatMap((doc) => doc.entries),
    OPTION_HELP_COLUMN,
  );
