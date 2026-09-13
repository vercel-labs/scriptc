/* Library-mode profile: the published configuration file an embedder ships to
 * name its ABI (symbol prefix, entry module, export map with per-param/
 * return marshalling classes, and the mode-provided symbol names). The
 * profile is configuration, not code — scriptc knows nothing about any
 * particular embedder; a second embedder writes its own profile against the
 * same mode. Every validation failure is SC4001 with the offending JSON
 * path named (the design's "profile malformed" family: parse errors,
 * meaning-changing unknown fields, prefix violations, duplicate symbols,
 * bad C identifiers).
 *
 * Ratified shape (the ratified library-mode design §5.1 + the ABI ratification session):
 *   {
 *     "profile_format": 1,
 *     "name": "<embedder identity string>",
 *     "entry": "src/lib.ts",                  // ONE module, profile-relative
 *     "emission": "llvm" | "c",                // pins the emission; no fallback
 *     "optimization": "release" | "dev",       // optional; default release
 *     "abi": {
 *       "prefix": "<prefix>_",
 *       "init_symbol": "<prefix>_init",
 *       "sink_register_symbol": "<prefix>_set_panic_sink",
 *       "collect_symbol": "<prefix>_collect" | null,   // session ruling 2
 *       "result_reset_symbol": "<prefix>_reset" | null, // §4.3 two postures
 *       "drain_symbol": "<prefix>_drain" | null,  // the job checkpoint:
 *                                                // run the pending
 *                                                // promise continuations,
 *                                                // then return (see below)
 *       "localize_runtime": false,               // multi-instance library
 *                                                // mode (see below); absent
 *                                                // = false, the classic
 *                                                // single-archive artifact
 *       "instance_per_thread": false,            // thread-instanced state
 *                                                // (see below); absent =
 *                                                // false, one instance per
 *                                                // linked archive
 *       "callback_register_symbol":              // host-callback channel
 *         "<prefix>_set_callback"                // registration (see below);
 *                                                // required exactly when
 *                                                // `callbacks` declares
 *                                                // channels
 *     },
 *     "exports": [ { "export": "update", "symbol": "<prefix>_update",
 *                    "params": ["f64", "string"], "returns": "bytes" } ],
 *     "callbacks": [ { "name": "emitChunk",       // host-callback channels
 *                      "params": ["bytes", "u32"], // (see below); absent =
 *                      "returns": "void" } ],      // no callback surface

 *     "sidecar": { ... },                      // ask-2 contract sidecar
 *                                              // (see below); absent =
 *                                              // no sidecar is emitted
 *     "determinism": { ... }                   // the ask-5 surface:
 *                                              // `teachings`/`remediations`
 *                                              // maps (the SC4004/SC4005
 *                                              // rider generalized + the
 *                                              // structured trap-teaching
 *                                              // encoding's text sources)
 *                                              // and the `fences` array —
 *                                              // deny-by-manifest-id
 *                                              // entries, each exactly one
 *                                              // of id/prefix plus optional
 *                                              // teaching/remediation
 *                                              // (fence-eval.ts resolves
 *                                              // them against this
 *                                              // release's surface
 *                                              // manifest at load);
 *                                              // everything else under
 *                                              // `determinism` stays
 *                                              // reserved and ignored
 *   }
 *
 * The `sidecar` section (ask 2): when present, the same invocation that
 * emits the archive also emits the machine-readable contract sidecar
 * (schema format 1) and the two profile-declared identity getters. The
 * profile supplies the schema's echoed constants and designations:
 *
 *   "sidecar": {
 *     "path": "app.contract.json",             // optional; resolved beside
 *                                              // the archive; the neutral
 *                                              // default when unstated is
 *                                              // <out>.contract.json
 *     "wire_version": 3,                       // echoed
 *     "abi_version": 1,                        // echoed + getter-exported
 *     "snapshot_format": 1,                    // echoed
 *     "build_id_symbol": "<prefix>build_id",   // u64 identity getter
 *     "abi_version_symbol": "<prefix>abi_version", // u32 identity getter
 *     "model": "Model",                        // entry's exported root
 *                                              // state type (interface)
 *     "msg": "Msg",                            // entry's exported message
 *                                              // union type (tagged alias)
 *     "init_export": "init",                   // optional, default "init"
 *     "update_export": "update",               // optional, default "update"
 *     "subscriptions_export": "subscriptions", // optional, default
 *     "source_hash": "module-graph"            // optional; the one v1
 *                                              // hashing contract
 *   }
 *
 * The COMPILATION ROOT for sidecar purposes is the profile file's
 * directory: the sidecar's `entry` field and the build_id/source_hash
 * canonical module paths are root-relative POSIX paths. The identity
 * getters are pure data returns exempt from the poisoned guard and every
 * runtime touch (ratified): callable before init and after a trap.
 *
 * Multi-instance library mode (`abi.localize_runtime: true`): the archive's
 * runtime internals — allocator, cycle collector, result arena, panic-sink
 * registration, every other piece of runtime state — are demoted to LOCAL
 * symbols behind the profile's prefix, so an ordinary archive's only
 * external definitions are the profile-declared symbols. External references
 * are the target's C/math runtime and system APIs: Windows embedders
 * additionally link advapi32, iphlpapi, and ws2_32, while the platform driver
 * supplies its ordinary CRT and kernel imports. Sanitized artifacts also
 * carry their sanitizer ABI; Darwin ASan's image-registration COMMON
 * deliberately remains shared so the final Mach-O image registers its
 * globals exactly once. N such archives, built under pairwise-distinct
 * prefixes, then link into ONE process with no scriptc-runtime symbol
 * collisions or shared
 * mutable state: each instance owns a private copy of the whole runtime,
 * panic sinks register per instance, and a trap poisons only the instance it
 * fired in. The embedder contract that makes this sound:
 *
 *   - Each instance keeps the single-threaded execution model. The embedder
 *     confines each instance to one thread and never enters one instance
 *     from two threads; different instances may run on different threads
 *     concurrently.
 *   - No value crosses instances directly: results are instance-owned
 *     memory with instance-tied lifetimes, so data moves between instances
 *     only through the embedder's own byte/record marshalling.
 *
 * Off by default: an absent or false `localize_runtime` produces the
 * classic artifact, byte-for-byte. Localization follows the archive's
 * object format: ELF and COFF archives localize on any supported host
 * (native or cross); Mach-O localization runs the macOS host linker, so
 * macos and ios targets build on darwin hosts and refuse elsewhere with
 * SC3002.
 *
 * Mobile targets: SCRIPTC_TARGET=aarch64-apple-ios,
 * aarch64-apple-ios-simulator, and aarch64-linux-android build library
 * archives for an embedding app to link (Xcode / Gradle+NDK); the
 * executable lane refuses those triples with SC3002. The minimum-version
 * floors are part of the target contract: iOS archives build for iOS 15.0
 * (every object carries LC_BUILD_VERSION minos 15.0 for the device or
 * simulator platform), Android archives for API level 26 (the bionic stub
 * level the embedder's minSdkVersion must meet). iOS targets require a
 * darwin host with Xcode's iPhoneOS/iPhoneSimulator SDK; Android targets
 * require an NDK (ANDROID_NDK_ROOT, or discovered under the SDK's ndk/
 * directory) on any host. Both `localize_runtime` and
 * `instance_per_thread` compose with the mobile targets exactly as on
 * desktop targets: iOS localization rides the Mach-O recipe, Android the
 * in-process ELF transform.
 *
 * Thread-instanced state (`abi.instance_per_thread: true`): every mutable
 * piece of the archive's state — the runtime units' internals AND the
 * program's globals, run-once guards, and lazily-compiled regex literal
 * caches — compiles as thread-local storage, so ONE linked archive serves
 * N instances: a thread that calls the init entry owns a complete,
 * independent instance through the unchanged entry family (no handle
 * parameter exists; the calling thread IS the instance selector). Sinks,
 * the poison flag, the result arena, and the collector are all
 * per instance, so a trap poisons only the instance it fired in. The
 * contract extends the multi-instance one:
 *
 *   - One instance per thread, selected implicitly by the calling thread;
 *     each thread that will serve requests calls the init entry first.
 *   - An instance's lifetime is its thread's lifetime; entering it from
 *     any other thread is undefined (unchanged rule). Ending a thread ends
 *     its instance without teardown — memory owned by the instance is
 *     reclaimed at process exit, so long-lived pools should reuse threads
 *     rather than cycle them.
 *   - No value crosses instances (the marshalling rule above, unchanged).
 *
 * Independent of `localize_runtime`, and composable with it: a thread-
 * instanced archive that must coexist with OTHER archives in one process
 * declares both. Off by default; non-opted builds are byte-for-byte
 * unchanged.
 *
 * Host-callback channels (`callbacks` + `abi.callback_register_symbol`):
 * the mode's outbound seam. A library's default outbound channels are
 * entry return values and the panic sink; a declared callback channel adds
 * a synchronous byte/scalar path from compiled code to the embedder — the
 * sink's pattern generalized: a profile-named registration symbol, a
 * host-supplied function pointer plus opaque context, calls arriving on
 * the calling thread. Each channel entry declares:
 *
 *   - `name`: the channel's identity — the registration name string AND
 *     the TypeScript binding compiled code calls. Program code reaches the
 *     channel as a signature-only ambient declaration whose signature must
 *     fit the declared classes (`declare function emitChunk(chunk:
 *     Uint8Array, seq: number): void`); a call of such a declaration that
 *     names no channel refuses SC4024 (only when the profile declares at
 *     least one channel — a callback-free profile keeps the ordinary
 *     ambient ReferenceError semantics, and its artifact is unchanged).
 *     Direct calls only, the FFI binding rule.
 *   - `params`: f64, bool, string, bytes, and the u8/u32/i32 plumbing
 *     classes (outbound plumbing rides JS's own ToUint32/ToInt32, the
 *     executable FFI lane's rule). string/bytes arrive as (ptr, len)
 *     pairs BORROWED for the duration of the call only.
 *   - `returns`: f64, bool, u8, u32, i32, or void — scalars only (a
 *     buffer return needs an ownership contract the mode does not define,
 *     the FFI format-1 ruling).
 *
 * The registration symbol's C shape, one per profile:
 *
 *   int32_t <sym>(const char *name, void (*fn)(void), void *ctx);
 *
 * name selects the channel by its declared `name` (NUL-terminated); fn is
 * stored as shown and cast to the channel's typed shape at the call site:
 *
 *   <ret> (*)(void *ctx, <params...>)   // ctx first, the sink's layout
 *
 * Returns 0 on success, -1 for an unknown or NULL name (a defined
 * refusal, never a store). Latest registration wins; a NULL fn clears the
 * channel; registration is a pure store — no entry prologue, no poison
 * guard, legal before init — and registrations persist across init/reset.
 * Its first operation still rejects an active host callback, before even a
 * NULL-name check or dispatch, so callback-time registration cannot mutate
 * a slot or hide a re-entry error.
 * Calling a channel the host never registered is the SC4025 runtime trap
 * through the panic sink (structured, naming the channel in the text and
 * the entry the host called in the symbol field): register every channel
 * an operation can reach before invoking that entry.
 *
 * Instance semantics compose exactly like the sink's: under
 * `localize_runtime` the channel slots are per-archive (each instance owns
 * a private registration set); under `instance_per_thread` they are
 * per-instance THREAD-LOCAL state — a callback registered on thread T
 * fires only for T's instance, and each serving thread registers its own
 * channels before calling the init entry.
 *
 * Reentrancy is pinned like the sink's rule: a callback runs on the
 * calling thread, inside the entry's dynamic extent, and must NOT call
 * back into any library entry (exports, init, result reset, collect, panic
 * sink registration, or callback registration) or unwind/longjmp across
 * library frames — read the borrowed buffers, hand the bytes to the
 * embedder's own structures, return. An attempted entry is SC4026: it
 * poisons only the affected instance, delivers once through the registered
 * sink, and places the attempted inner ABI symbol in structured field 2;
 * a sink that returns aborts. A later host-loop turn may enter after the
 * callback returns. The sidecar identity getters are the explicit pure-data
 * exception: they touch no mutable runtime state and remain callable before
 * init and after poison. The async_free posture is unchanged: a channel
 * adds no event loop, no threads, and no reentry into the archive.
 *
 * Marshalling classes (design §4.2 + session ruling 3 + ask 4): f64, bool,
 * string, bytes for params and returns; u8/u32/i32 are PARAM-ONLY plumbing
 * classes; i64/u64 are ask-4's declared integer boundary classes (params:
 * wrapper range-check inbound, compile-time proof at internal call sites;
 * returns: prove-or-refuse over every value reaching them); void is
 * return-only. Unknown fields are refused at EVERY level the loader reads
 * — the root included (the anti-inert posture: profiles pin per compiler
 * release, so an unknown root key is a typo or a misplaced section, never
 * forward-compat surface; the ask-5 key names at the root refuse with a
 * pointer to their `determinism.*` home, since a silently inert `fences`
 * array is exactly the footgun the fence machinery refuses everywhere
 * else). Only the INTERIOR of `determinism` keeps a reserved-and-ignored
 * surface beyond the three ask-5 keys. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { libProfileDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { resolveLibraryFences, type LibraryFenceDecl, type ResolvedLibraryFence } from "./fence-eval.js";

/** Marshalling classes legal in PARAMETER position: the v1 classes plus
 * ask 4's declared integer boundary classes. An i64/u64 PARAMETER is an
 * FFI edge contract on both sides: inbound host calls range-check in the
 * marshalled wrapper (values past ±(2^53−1) cannot ride f64 exactly — the
 * SC4012 host-contract trap), and internal call sites must PROVE the
 * argument whole-in-range at compile time (library/int-infer.ts). */
export const LIB_PARAM_CLASSES = ["f64", "bool", "string", "bytes", "u8", "u32", "i32", "i64", "u64"] as const;
/** Marshalling classes legal in RETURN position: the value classes, void,
 * and ask 4's i64/u64 — an integer RETURN compiles only when every value
 * reaching it is PROVEN whole and in range (prove-or-refuse; the wrapper's
 * (int64_t)/(uint64_t) conversion is then exact by construction). The
 * u8/u32/i32 plumbing classes stay param-only: they were ratified as
 * inbound plumbing, and outbound integers are the proven classes'
 * business. */
export const LIB_RETURN_CLASSES = ["f64", "bool", "string", "bytes", "void", "i64", "u64"] as const;

/** Ask 4's declared integer classes (the prove-or-refuse pair). */
export type LibIntClass = "i64" | "u64";

export type LibParamClass = (typeof LIB_PARAM_CLASSES)[number];
export type LibReturnClass = (typeof LIB_RETURN_CLASSES)[number];

/** Marshalling classes legal in a CALLBACK PARAMETER position (outbound:
 * compiled code → host). The value classes plus the u8/u32/i32 plumbing
 * classes — outbound plumbing rides JS's own ToUint32/ToInt32 conversions
 * (the executable FFI lane's rule), so no new coercion story exists. The
 * declared integer classes stay export-map surface: an outbound i64/u64
 * demands the prove-or-refuse machinery, which is scoped to export
 * returns today. */
const LIB_CALLBACK_PARAM_CLASSES = ["f64", "bool", "string", "bytes", "u8", "u32", "i32"] as const;
/** Marshalling classes legal in a CALLBACK RETURN position (inbound: host
 * → compiled code). Scalars only — every conversion to f64 is exact by
 * construction; a buffer return would need an ownership contract the mode
 * does not define (the FFI format-1 ruling). */
const LIB_CALLBACK_RETURN_CLASSES = ["f64", "bool", "u8", "u32", "i32", "void"] as const;
/** The runtime's fixed channel-slot capacity (scr_library.c's
 * SCR_LIB_MAX_CALLBACKS — keep the two in step). */
const LIB_MAX_CALLBACKS = 32;

export type LibCallbackParamClass = (typeof LIB_CALLBACK_PARAM_CLASSES)[number];
export type LibCallbackReturnClass = (typeof LIB_CALLBACK_RETURN_CLASSES)[number];

/** One declared host-callback channel (see the header contract). */
export interface LibraryCallbackEntry {
  /** The channel's identity: the registration name string and the
   * TypeScript binding compiled code calls. */
  name: string;
  params: LibCallbackParamClass[];
  returns: LibCallbackReturnClass;
}

export interface LibraryExportEntry {
  /** The entry module's export name. */
  export: string;
  /** The external C symbol the wrapper is emitted under. */
  symbol: string;
  params: LibParamClass[];
  returns: LibReturnClass;
}

/** The ask-2 contract-sidecar configuration: the profile-declared echo
 * constants, identity-getter symbols, and contract designations. Presence
 * of the section turns sidecar emission on for the invocation. */
export interface LibrarySidecarConfig {
  /** Sidecar file, resolved beside the archive; null selects the neutral
   * default `<out>.contract.json`. */
  path: string | null;
  wireVersion: number;
  abiVersion: number;
  snapshotFormat: number;
  /** The u64 build_id identity getter's C symbol. */
  buildIdSymbol: string;
  /** The u32 abi_version identity getter's C symbol. */
  abiVersionSymbol: string;
  /** The entry module's exported root state type (an interface). */
  model: string;
  /** The entry module's exported message union type (a tagged alias). */
  msg: string;
  /** The exported init/update/subscriptions function names the shape
   * flags key on (and model_helpers excludes). */
  initExport: string;
  updateExport: string;
  subscriptionsExport: string;
  /** True only when `sidecar.subscriptions_export` is present in the
   * profile. Omission keeps subscriptions optional; a declared name is a
   * reference that must resolve to an exported function. */
  subscriptionsExportDeclared: boolean;
  /** The profile-selected source-tree hashing contract. v1 implements
   * exactly one: "module-graph" (wyhash-64, seed 0xc0de5eed, over the
   * length-prefixed sorted module graph — canonical root-relative POSIX
   * paths and exact source bytes). */
  sourceHash: "module-graph";
  /** Ask 4's declared integer boundary slots, keyed by the sidecar's slot
   * path grammar (`Msg.count`, `Point.x`, `helpers.clamp.params[0]`,
   * `helpers.clamp.return`). Each named slot must resolve to a bare or
   * optional NUMBER slot of the projected contract (refused at sidecar
   * build otherwise), is spelled i64 (or optional<i64>) in the emitted
   * document's TypeRef/descriptor (the frozen format-1 type vocabulary has
   * no u64 — unsigned-ness is a boundary-slot refinement, not a type-table
   * concept), joins
   * `integer_slots` with its DECLARED class ({i64, u64} — the u64
   * declaration is the stricter obligation, and the attestation records
   * the class whose proof was discharged), and obligates every
   * program-side value that can reach it to the prove-or-refuse check.
   * Empty when the profile declares none. */
  integerSlots: { slot: string; cls: "i64" | "u64" }[];
}

export interface LibraryProfile {
  profileFormat: 1;
  name: string;
  /** The profile file that produced this configuration. Semantic
   * designation errors anchor here, where the offending name is written. */
  profilePath: string;
  /** Resolved absolute path of the ONE entry module. */
  entry: string;
  /** The pinned emission — no fallback concept exists on the library path. */
  emission: "llvm" | "c";
  /** Native optimizer posture. release preserves the production -O2 archive;
   * dev uses -O0 for fast iterative embedding builds. */
  optimization: "release" | "dev";
  prefix: string;
  initSymbol: string;
  sinkRegisterSymbol: string;
  /** Session ruling 2's mode-provided collect entry (delegates to the
   * runtime cycle collector; snapshot-invariant, arena-resetting). Null =
   * the profile declares none. */
  collectSymbol: string | null;
  /** §4.3: declared → results accumulate until the host calls it; null →
   * every entry prologue resets the result arena. */
  resultResetSymbol: string | null;
  /** The job checkpoint: declared → the archive exports an entry that runs
   * the pending process.nextTick and promise-job queues to exhaustion and
   * returns; null → no such entry (the byte-identical artifact a
   * drain-free profile always produced).
   *
   * Declaring it does NOT give the artifact an event loop. The entry reads
   * no clock, fires no timer, polls no descriptor, creates no thread, and
   * installs no handler — the v1 contract is unchanged, and the SC4005
   * gate still refuses every surface a loop turn would service. It is the
   * point at which a host that owns the thread says "now run what is
   * ready", which is what `async` functions in the graph need and all they
   * need. */
  drainSymbol: string | null;
  /** Multi-instance library mode: true localizes every runtime-internal
   * symbol so N archives with distinct prefixes link into one process (see
   * the header contract). False (the default) produces the classic
   * single-archive artifact unchanged. */
  localizeRuntime: boolean;
  /** Thread-instanced state: true compiles every mutable static — runtime
   * internals and program globals — as thread-local storage, so one linked
   * archive serves one independent instance per embedder thread through
   * the unchanged entry family (see the header contract). False (the
   * default) keeps one instance per linked archive. */
  instancePerThread: boolean;
  /** The host-callback registration symbol (see the header contract):
   * non-null exactly when `callbacks` declares channels. */
  callbackRegisterSymbol: string | null;
  /** The declared host-callback channels, in declaration order (the order
   * IS the runtime slot assignment). Empty when the profile declares
   * none — the callback-free artifact is unchanged. */
  callbacks: LibraryCallbackEntry[];
  exports: LibraryExportEntry[];
  /** The ask-2 contract-sidecar section; null = the profile declares no
   * sidecar and the invocation emits none. */
  sidecar: LibrarySidecarConfig | null;
  /** The profile file's exact bytes — build_id input 2 (the profile
   * identity: two compiles under different profiles are different
   * builds). */
  profileBytes: Uint8Array;
  /** Profile-supplied teaching text (the ratified SC4004/SC4005 rider,
   * extended by the structured trap-teaching encoding): keyed by diagnostic
   * code ("SC4005"), with "async" accepted as the shared key for both
   * async-surface codes. Refusal teachings ride the diagnostic hint;
   * runtime-trap teachings become the structured sink message's text
   * field. Keys and values are validated free of the encoding's reserved
   * bytes (0x01/0x1F) — keys as bare tokens, never for registry membership
   * (embedder code spaces are the embedder's; SC is the compiler's). */
  teachings: Readonly<Record<string, string>>;
  /** Profile-supplied remediation text, keyed like `teachings`: the
   * structured trap-teaching message's optional fourth field — the whole
   * field is absent from the assembled bytes when the profile supplies
   * none. Same reserved-byte validation as `teachings`. */
  remediations: Readonly<Record<string, string>>;
  /** The ask-5 determinism fences, resolved at load against this compiler
   * release's surface manifest (fence-eval.ts): unknown ids/prefixes and
   * unpoliceable static entries refused SC4001, never accepted as inert.
   * Empty when the profile declares none. */
  fences: readonly ResolvedLibraryFence[];
}

const C_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class ProfileError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function req<T>(v: unknown, path: string, kind: "string" | "number" | "boolean"): T {
  if (typeof v !== kind) {
    throw new ProfileError(`'${path}' must be a ${kind}${v === undefined ? " (missing)" : ""}`);
  }
  return v as T;
}

function symbolField(v: unknown, path: string, prefix: string, nullable: boolean): string | null {
  if (nullable && (v === null || v === undefined)) return null;
  const s = req<string>(v, path, "string");
  if (!C_IDENT.test(s)) throw new ProfileError(`'${path}' is not a valid C identifier: '${s}'`);
  if (!s.startsWith(prefix)) {
    throw new ProfileError(`'${path}' must start with the profile prefix '${prefix}': '${s}'`);
  }
  return s;
}

function rejectUnknownKeys(obj: object, path: string, known: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      throw new ProfileError(`unknown field '${path}.${k}' (a typo here would change the ABI; remove it)`);
    }
  }
}

/** Parse + validate a profile file. Returns the profile or the SC4001
 * diagnostics (one per problem found before parsing had to stop). */
export function loadLibraryProfile(
  profilePath: string,
): { ok: true; profile: LibraryProfile } | { ok: false; diagnostics: ScrDiagnostic[] } {
  const fail = (detail: string): { ok: false; diagnostics: ScrDiagnostic[] } => ({
    ok: false,
    diagnostics: [libProfileDiag(detail, profilePath)],
  });
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(profilePath);
  } catch (e) {
    return fail(`cannot read profile: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return fail(`profile is not valid JSON (${(e as Error).message})`);
  }
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ProfileError("profile must be a JSON object");
    }
    const p = raw as Record<string, unknown>;
    const format = req<number>(p["profile_format"], "profile_format", "number");
    if (format !== 1) throw new ProfileError(`unsupported profile_format ${format} (this scriptc reads format 1)`);
    // Root keys are strict (checked AFTER the format gate, so a future
    // format's profile refuses as the wrong format, not as a typo). The
    // ask-5 key names get the pointed message: a `fences` array pasted at
    // the root would otherwise be silently inert — the exact footgun the
    // fence machinery refuses everywhere else.
    for (const k of Object.keys(p)) {
      if (["profile_format", "name", "entry", "emission", "optimization", "abi", "exports", "callbacks", "sidecar", "determinism"].includes(k)) continue;
      if (k === "fences" || k === "teachings" || k === "remediations") {
        throw new ProfileError(
          `'${k}' at the profile root does nothing — the ask-5 determinism surface lives under 'determinism.${k}'; move it there`,
        );
      }
      throw new ProfileError(`unknown field '${k}' (root keys are strict: a typo here would silently change the build; remove it)`);
    }
    const name = req<string>(p["name"], "name", "string");
    if (name === "") throw new ProfileError("'name' must be a non-empty identity string");
    const entryRel = req<string>(p["entry"], "entry", "string");
    if (entryRel === "") throw new ProfileError("'entry' must name the profile's one entry module");
    const emission = req<string>(p["emission"], "emission", "string");
    if (emission !== "llvm" && emission !== "c") {
      throw new ProfileError(`'emission' must be "llvm" or "c", got '${emission}'`);
    }
    const optimization = p["optimization"] === undefined
      ? "release"
      : req<string>(p["optimization"], "optimization", "string");
    if (optimization !== "release" && optimization !== "dev") {
      throw new ProfileError(`'optimization' must be "release" or "dev", got '${optimization}'`);
    }
    const abi = p["abi"];
    if (abi === null || typeof abi !== "object" || Array.isArray(abi)) {
      throw new ProfileError("'abi' must be an object");
    }
    rejectUnknownKeys(abi, "abi", ["prefix", "init_symbol", "sink_register_symbol", "collect_symbol", "result_reset_symbol", "drain_symbol", "localize_runtime", "instance_per_thread", "callback_register_symbol"]);
    const a = abi as Record<string, unknown>;
    const prefix = req<string>(a["prefix"], "abi.prefix", "string");
    if (!C_IDENT.test(prefix)) {
      throw new ProfileError(`'abi.prefix' is not a valid C identifier fragment: '${prefix}'`);
    }
    const initSymbol = symbolField(a["init_symbol"], "abi.init_symbol", prefix, false)!;
    const sinkRegisterSymbol = symbolField(a["sink_register_symbol"], "abi.sink_register_symbol", prefix, false)!;
    const collectSymbol = symbolField(a["collect_symbol"], "abi.collect_symbol", prefix, true);
    const resultResetSymbol = symbolField(a["result_reset_symbol"], "abi.result_reset_symbol", prefix, true);
    const drainSymbol = symbolField(a["drain_symbol"], "abi.drain_symbol", prefix, true);
    // Multi-instance library mode: strictly boolean when present (the field
    // gates the artifact's whole link surface, so a truthy non-boolean is a
    // refusal, never a coercion).
    const localizeRuntime =
      a["localize_runtime"] === undefined
        ? false
        : req<boolean>(a["localize_runtime"], "abi.localize_runtime", "boolean");
    // Thread-instanced state: same strict-boolean rule — the field gates
    // where every mutable static of the artifact lives.
    const instancePerThread =
      a["instance_per_thread"] === undefined
        ? false
        : req<boolean>(a["instance_per_thread"], "abi.instance_per_thread", "boolean");
    const callbackRegisterSymbol = symbolField(a["callback_register_symbol"], "abi.callback_register_symbol", prefix, true);

    const exportsRaw = p["exports"];
    if (!Array.isArray(exportsRaw)) throw new ProfileError("'exports' must be an array");
    const entries: LibraryExportEntry[] = [];
    exportsRaw.forEach((e, i) => {
      const path = `exports[${i}]`;
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        throw new ProfileError(`'${path}' must be an object`);
      }
      rejectUnknownKeys(e, path, ["export", "symbol", "params", "returns"]);
      const ee = e as Record<string, unknown>;
      const exportName = req<string>(ee["export"], `${path}.export`, "string");
      if (exportName === "") throw new ProfileError(`'${path}.export' must be a non-empty export name`);
      const symbol = symbolField(ee["symbol"], `${path}.symbol`, prefix, false)!;
      const paramsRaw = ee["params"];
      if (!Array.isArray(paramsRaw)) throw new ProfileError(`'${path}.params' must be an array`);
      const params = paramsRaw.map((c, j) => {
        if (typeof c !== "string" || !(LIB_PARAM_CLASSES as readonly string[]).includes(c)) {
          throw new ProfileError(
            `'${path}.params[${j}]' must be one of ${LIB_PARAM_CLASSES.join("/")}, got ${JSON.stringify(c)}`,
          );
        }
        return c as LibParamClass;
      });
      const returns = req<string>(ee["returns"], `${path}.returns`, "string");
      if (!(LIB_RETURN_CLASSES as readonly string[]).includes(returns)) {
        const detail =
          returns === "u8" || returns === "u32" || returns === "i32"
            ? `'${path}.returns': the u8/u32/i32 plumbing classes are parameter-only — an outbound integer return is declared i64 or u64 and compiles only when every value reaching it proves whole and in ±(2^53 − 1) (ask 4's prove-or-refuse)`
            : `'${path}.returns' must be one of ${LIB_RETURN_CLASSES.join("/")}, got '${returns}'`;
        throw new ProfileError(detail);
      }
      entries.push({ export: exportName, symbol, params, returns: returns as LibReturnClass });
    });

    // Host-callback channels: the outbound seam's declaration (see the
    // header contract). The section is strict like exports — a typo'd
    // class or key would change the C shape the host implements with no
    // signal.
    const callbacks: LibraryCallbackEntry[] = [];
    const cbRaw = p["callbacks"];
    if (cbRaw !== undefined && cbRaw !== null) {
      if (!Array.isArray(cbRaw)) throw new ProfileError("'callbacks' must be an array");
      cbRaw.forEach((c, i) => {
        const path = `callbacks[${i}]`;
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          throw new ProfileError(`'${path}' must be an object`);
        }
        rejectUnknownKeys(c, path, ["name", "params", "returns"]);
        const cc = c as Record<string, unknown>;
        const cbName = req<string>(cc["name"], `${path}.name`, "string");
        // The name is BOTH the registration name string and the ambient
        // TypeScript binding — one grammar serves both sides (and stays a
        // clean C string literal in the generated dispatch).
        if (!C_IDENT.test(cbName)) {
          throw new ProfileError(
            `'${path}.name' is not a valid channel name: '${cbName}' (a channel name is the TypeScript binding compiled code calls and the registration name string — letters, digits, underscore, not starting with a digit)`,
          );
        }
        const paramsRaw = cc["params"];
        if (!Array.isArray(paramsRaw)) throw new ProfileError(`'${path}.params' must be an array`);
        const cbParams = paramsRaw.map((cls, j) => {
          if (typeof cls === "string" && (cls === "i64" || cls === "u64")) {
            throw new ProfileError(
              `'${path}.params[${j}]': the declared integer classes are export-map surface — an outbound callback scalar is f64 (whole values ride exactly to ±(2^53 − 1)) or one of the u8/u32/i32 plumbing classes (JS ToUint32/ToInt32 semantics)`,
            );
          }
          if (typeof cls !== "string" || !(LIB_CALLBACK_PARAM_CLASSES as readonly string[]).includes(cls)) {
            throw new ProfileError(
              `'${path}.params[${j}]' must be one of ${LIB_CALLBACK_PARAM_CLASSES.join("/")}, got ${JSON.stringify(cls)}`,
            );
          }
          return cls as LibCallbackParamClass;
        });
        const cbReturns = req<string>(cc["returns"], `${path}.returns`, "string");
        if (!(LIB_CALLBACK_RETURN_CLASSES as readonly string[]).includes(cbReturns)) {
          const detail =
            cbReturns === "string" || cbReturns === "bytes"
              ? `'${path}.returns': a callback return stays scalar — a buffer flowing host → library needs an ownership contract the mode does not define; pass buffers as callback parameters (library → host, borrowed for the call) or entry parameters instead`
              : `'${path}.returns' must be one of ${LIB_CALLBACK_RETURN_CLASSES.join("/")}, got '${cbReturns}'`;
          throw new ProfileError(detail);
        }
        callbacks.push({ name: cbName, params: cbParams, returns: cbReturns as LibCallbackReturnClass });
      });
      if (callbacks.length > LIB_MAX_CALLBACKS) {
        throw new ProfileError(
          `'callbacks' declares ${callbacks.length} channels — the runtime's slot capacity is ${LIB_MAX_CALLBACKS}`,
        );
      }
    }
    // Presence pairing (the anti-inert posture, both directions): channels
    // without a registration symbol are unreachable by any host, and a
    // registration symbol without channels is a symbol that can only
    // answer -1.
    if (callbacks.length > 0 && callbackRegisterSymbol === null) {
      throw new ProfileError(
        "'callbacks' declares channels but 'abi.callback_register_symbol' is missing — the host registers channel implementations through that symbol",
      );
    }
    if (callbacks.length === 0 && callbackRegisterSymbol !== null) {
      throw new ProfileError(
        "'abi.callback_register_symbol' is declared but 'callbacks' declares no channels — remove the symbol or declare the channels it registers",
      );
    }
    {
      const seen = new Set<string>();
      for (const cb of callbacks) {
        if (seen.has(cb.name)) throw new ProfileError(`callback channel '${cb.name}' is declared twice`);
        seen.add(cb.name);
      }
      for (const e of entries) {
        if (seen.has(e.export)) {
          throw new ProfileError(
            `'${e.export}' is both an export-map export and a callback channel name — a channel is a signature-only ambient declaration, an export is an entry function; one binding cannot be both`,
          );
        }
      }
    }

    // The ask-2 sidecar section: presence turns contract emission on.
    // Unknown fields inside it are refused like abi's (a typo here would
    // silently change the emitted contract).
    let sidecar: LibrarySidecarConfig | null = null;
    const sc = p["sidecar"];
    if (sc !== undefined && sc !== null) {
      if (typeof sc !== "object" || Array.isArray(sc)) throw new ProfileError("'sidecar' must be an object");
      rejectUnknownKeys(sc, "sidecar", [
        "path", "wire_version", "abi_version", "snapshot_format",
        "build_id_symbol", "abi_version_symbol", "model", "msg",
        "init_export", "update_export", "subscriptions_export", "source_hash",
        "integer_slots",
      ]);
      const s = sc as Record<string, unknown>;
      const intField = (key: string): number => {
        const v = req<number>(s[key], `sidecar.${key}`, "number");
        if (!Number.isInteger(v) || v < 0) {
          throw new ProfileError(`'sidecar.${key}' must be a non-negative integer, got ${v}`);
        }
        return v;
      };
      const nameField = (key: string, fallback: string | null): string => {
        if (s[key] === undefined && fallback !== null) return fallback;
        const v = req<string>(s[key], `sidecar.${key}`, "string");
        if (v === "") throw new ProfileError(`'sidecar.${key}' must be a non-empty name`);
        return v;
      };
      let path: string | null = null;
      if (s["path"] !== undefined && s["path"] !== null) {
        const v = req<string>(s["path"], "sidecar.path", "string");
        if (v === "") throw new ProfileError("'sidecar.path' must be a non-empty relative path");
        if (isAbsolute(v)) {
          throw new ProfileError("'sidecar.path' must be relative (the sidecar is written beside the archive)");
        }
        path = v;
      }
      const sourceHash = s["source_hash"] === undefined ? "module-graph" : req<string>(s["source_hash"], "sidecar.source_hash", "string");
      if (sourceHash !== "module-graph") {
        throw new ProfileError(
          `'sidecar.source_hash' names an unknown hashing contract '${sourceHash}' (this scriptc implements "module-graph")`,
        );
      }
      // Ask 4's declared integer boundary slots: each entry names a
      // contract slot by its sidecar path and picks the integer class.
      // Path RESOLUTION happens at sidecar build (the contract must
      // exist first); here the shape is pinned — a typo'd key or class
      // would silently change an ABI obligation.
      const integerSlots: { slot: string; cls: "i64" | "u64" }[] = [];
      const isRaw = s["integer_slots"];
      if (isRaw !== undefined && isRaw !== null) {
        if (!Array.isArray(isRaw)) throw new ProfileError("'sidecar.integer_slots' must be an array");
        const seenSlots = new Set<string>();
        isRaw.forEach((entry, i) => {
          const epath = `sidecar.integer_slots[${i}]`;
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new ProfileError(`'${epath}' must be an object`);
          }
          rejectUnknownKeys(entry, epath, ["slot", "class"]);
          const ee2 = entry as Record<string, unknown>;
          const slot = req<string>(ee2["slot"], `${epath}.slot`, "string");
          if (slot === "") throw new ProfileError(`'${epath}.slot' must be a non-empty slot path`);
          const cls = req<string>(ee2["class"], `${epath}.class`, "string");
          if (cls !== "i64" && cls !== "u64") {
            throw new ProfileError(`'${epath}.class' must be "i64" or "u64", got '${cls}'`);
          }
          if (seenSlots.has(slot)) throw new ProfileError(`'${epath}.slot' repeats slot path '${slot}'`);
          seenSlots.add(slot);
          integerSlots.push({ slot, cls });
        });
      }
      sidecar = {
        path,
        wireVersion: intField("wire_version"),
        abiVersion: intField("abi_version"),
        snapshotFormat: intField("snapshot_format"),
        buildIdSymbol: symbolField(s["build_id_symbol"], "sidecar.build_id_symbol", prefix, false)!,
        abiVersionSymbol: symbolField(s["abi_version_symbol"], "sidecar.abi_version_symbol", prefix, false)!,
        model: nameField("model", null),
        msg: nameField("msg", null),
        initExport: nameField("init_export", "init"),
        updateExport: nameField("update_export", "update"),
        subscriptionsExport: nameField("subscriptions_export", "subscriptions"),
        subscriptionsExportDeclared: s["subscriptions_export"] !== undefined,
        sourceHash: "module-graph",
        integerSlots,
      };
      if (sidecar.model === sidecar.msg) {
        throw new ProfileError(`'sidecar.msg' must differ from 'sidecar.model' ('${sidecar.model}')`);
      }
    }

    // Pairwise-distinct symbols across the whole declared set (exports +
    // the mode-provided entries).
    const all = new Map<string, string>();
    const claim = (sym: string | null, path: string): void => {
      if (sym === null) return;
      const prev = all.get(sym);
      if (prev !== undefined) {
        throw new ProfileError(`symbol '${sym}' is declared twice (${prev} and ${path}); symbols must be pairwise distinct`);
      }
      all.set(sym, path);
    };
    claim(initSymbol, "abi.init_symbol");
    claim(sinkRegisterSymbol, "abi.sink_register_symbol");
    claim(collectSymbol, "abi.collect_symbol");
    claim(resultResetSymbol, "abi.result_reset_symbol");
    claim(drainSymbol, "abi.drain_symbol");
    claim(callbackRegisterSymbol, "abi.callback_register_symbol");
    if (sidecar !== null) {
      claim(sidecar.buildIdSymbol, "sidecar.build_id_symbol");
      claim(sidecar.abiVersionSymbol, "sidecar.abi_version_symbol");
    }
    entries.forEach((e, i) => claim(e.symbol, `exports[${i}].symbol`));
    const exportNames = new Set<string>();
    entries.forEach((e, i) => {
      if (exportNames.has(e.export)) {
        throw new ProfileError(`export '${e.export}' is mapped twice (exports[${i}])`);
      }
      exportNames.add(e.export);
    });

    // Ask-5 surface: the teachings/remediations riders and the fences
    // array are read; everything else under `determinism` is reserved and
    // ignored. Teaching/remediation TEXT refuses every control byte below
    // 0x20 except newline (the ratified constraint: 0x01 and 0x1F are the
    // structured trap encoding's marker and separator — either inside
    // profile-authored text would corrupt the assembled sink message; the
    // remaining control bytes have no honest place in teaching prose) and
    // caps at 512 UTF-8 bytes per string. Keys are diagnostic codes
    // validated ONLY as control-free tokens — embedder code spaces belong
    // to the embedder (SC is the compiler registry's); membership is
    // never checked here.
    const teachings: Record<string, string> = {};
    const remediations: Record<string, string> = {};
    let fences: ResolvedLibraryFence[] = [];
    const RESERVED_TEXT = /[\u0000-\u0009\u000b-\u001f]/;
    const RESERVED_KEY = /[\u0000-\u001f]/;
    const checkRiderText = (v: string, path: string): void => {
      if (RESERVED_TEXT.test(v)) {
        throw new ProfileError(
          `'${path}' contains a reserved byte — control bytes below 0x20 are refused (0x01 and 0x1F are the structured trap encoding's marker and separator); teaching and remediation text must be plain UTF-8, newlines only`,
        );
      }
      const bytes = new TextEncoder().encode(v).length;
      if (bytes > 512) {
        throw new ProfileError(`'${path}' is ${bytes} bytes — teaching and remediation strings cap at 512 bytes`);
      }
    };
    const det = p["determinism"];
    if (det !== undefined && det !== null && typeof det === "object" && !Array.isArray(det)) {
      const readRider = (rider: "teachings" | "remediations", into: Record<string, string>): void => {
        const t = (det as Record<string, unknown>)[rider];
        if (t === undefined || t === null || typeof t !== "object" || Array.isArray(t)) return;
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof v !== "string") continue;
          if (RESERVED_KEY.test(k)) {
            throw new ProfileError(
              `'determinism.${rider}' key ${JSON.stringify(k)} contains a reserved byte — 0x01 and 0x1F are the structured trap encoding's marker and separator; a code must be a plain token`,
            );
          }
          checkRiderText(v, `determinism.${rider}.${k}`);
          into[k] = v;
        }
      };
      readRider("teachings", teachings);
      readRider("remediations", remediations);

      // The fences array (spec §1): each entry exactly one of id/prefix
      // plus optional teaching/remediation, unknown fields refused (a typo
      // here silently disarms a denial), and the selector resolved against
      // this release's surface manifest — unknown ids/prefixes refuse
      // loudly (ratified: fence profiles pin per compiler release).
      const fencesRaw = (det as Record<string, unknown>)["fences"];
      if (fencesRaw !== undefined && fencesRaw !== null) {
        if (!Array.isArray(fencesRaw)) throw new ProfileError("'determinism.fences' must be an array");
        const decls: LibraryFenceDecl[] = fencesRaw.map((f, i) => {
          const path = `determinism.fences[${i}]`;
          if (f === null || typeof f !== "object" || Array.isArray(f)) {
            throw new ProfileError(`'${path}' must be an object`);
          }
          rejectUnknownKeys(f, path, ["id", "prefix", "teaching", "remediation"]);
          const ff = f as Record<string, unknown>;
          if ((ff["id"] === undefined) === (ff["prefix"] === undefined)) {
            throw new ProfileError(`'${path}' must carry exactly one of 'id' or 'prefix'`);
          }
          const decl: LibraryFenceDecl = { path };
          if (ff["id"] !== undefined) {
            const id = req<string>(ff["id"], `${path}.id`, "string");
            if (id === "") throw new ProfileError(`'${path}.id' must be a non-empty manifest entry id`);
            decl.id = id;
          } else {
            const prefix = req<string>(ff["prefix"], `${path}.prefix`, "string");
            if (prefix === "") throw new ProfileError(`'${path}.prefix' must be a non-empty manifest id prefix`);
            decl.prefix = prefix;
          }
          for (const rider of ["teaching", "remediation"] as const) {
            if (ff[rider] === undefined) continue;
            const text = req<string>(ff[rider], `${path}.${rider}`, "string");
            checkRiderText(text, `${path}.${rider}`);
            decl[rider] = text;
          }
          return decl;
        });
        const resolved = resolveLibraryFences(decls);
        if (!resolved.ok) throw new ProfileError(resolved.detail);
        fences = resolved.fences;
      }
    }

    const entry = isAbsolute(entryRel) ? entryRel : resolve(dirname(profilePath), entryRel);
    return {
      ok: true,
      profile: {
        profileFormat: 1,
        name,
        profilePath,
        entry,
        emission,
        optimization,
        prefix,
        initSymbol,
        sinkRegisterSymbol,
        collectSymbol,
        resultResetSymbol,
        drainSymbol,
        localizeRuntime,
        instancePerThread,
        callbackRegisterSymbol,
        callbacks,
        exports: entries,
        sidecar,
        profileBytes: bytes,
        teachings,
        remediations,
        fences,
      },
    };
  } catch (e) {
    if (e instanceof ProfileError) return fail(e.detail);
    throw e;
  }
}

/** The profile's teaching text for one refusal code (the ratified rider:
 * SC4004/SC4005 carry profile-supplied guidance naming the embedder's
 * sanctioned alternative). Falls back to the shared "async" key. */
export function profileTeaching(profile: LibraryProfile, code: string): string | undefined {
  return profile.teachings[code] ?? (code === "SC4004" || code === "SC4005" ? profile.teachings["async"] : undefined);
}

/** The profile's remediation text for one code — the structured
 * trap-teaching message's optional fourth field. No shared-key fallback:
 * a remediation names one code's fix. A fence entry's `remediation` feeds
 * the same lookup through the codes its covered manifest entries carry
 * (spec §3: "a remediation in a fence entry or a `remediations` map" —
 * one data source for the field that already exists); an explicit map key
 * wins over a fence's, and the first declared fence wins among fences. */
export function profileRemediation(profile: LibraryProfile, code: string): string | undefined {
  const direct = profile.remediations[code];
  if (direct !== undefined) return direct;
  for (const fence of profile.fences) {
    if (fence.remediation === undefined) continue;
    if (fence.surfaces.some((s) => s.code === code)) return fence.remediation;
  }
  return undefined;
}
