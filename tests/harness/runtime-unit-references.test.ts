/** A runtime unit may call another unit's functions only when every program
 * that links the first links the second. The link features decide which
 * units a program links, so a call into a unit the feature does not select
 * is an undefined reference at link time, in exactly the programs that have
 * the one fact and not the other (an http2 session type in a signature and
 * no node:http2 call: scr_http2.c without scr_http.c).
 *
 * This reads the answer off the installed runtime pack. Each libCall name
 * and each handle type is a program of its own here: a module holding only
 * that call or that type, the link features the compiler derives for it
 * (executableLinkFeatures, with LINK_FEATURE_REQUIREMENTS applied), the
 * pack objects those select, and the `scr_` symbols a selected object leaves
 * undefined that no selected object defines. Selection only grows with the
 * facts of a program, so a set that is closed for each fact alone is closed
 * for every program made of them. Rules that read a call's arguments, the
 * module's classes or its string literals are not enumerated.
 *
 * The check is at the level of objects, and the link collects unreferenced
 * sections: a reference from a function that only a call selecting the other
 * unit reaches never becomes a link error. Those are KNOWN_REFERENCES. A
 * reference outside that list fails here; the fix is a line in
 * LINK_FEATURE_REQUIREMENTS (the feature cannot link without the other), or
 * a line in the list with the reason the reference is unreachable without
 * the other unit. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { executableLinkFeatures } from "../../packages/compiler/src/backend/executable-features.js";
import {
  selectRuntimePackArtifacts,
  selectedRuntimeUnits,
  type RuntimePackManifest,
} from "../../packages/compiler/src/backend/runtime-pack-core.js";
import { nativeCodegenTarget } from "../../packages/compiler/src/backend/targets.js";
import { libFnSignatures } from "../../packages/compiler/src/ir/builtin-signatures.js";
import {
  HANDLE_KINDS,
  type IrExpr,
  type IrModule,
  type IrType,
} from "../../packages/compiler/src/ir/ir.js";

const root = join(import.meta.dirname, "../..");
const target = nativeCodegenTarget();
const packDir =
  target === null
    ? null
    : join(root, "packages", target.runtimePackPackage.replace("@scriptc/", ""));
// The symbol names below are the ELF ones (Mach-O prefixes an underscore),
// and the list was recorded from the Linux pack.
const available =
  process.platform === "linux" &&
  target?.objectFormat === "elf" &&
  packDir !== null &&
  existsSync(join(packDir, "runtime-pack.json"));

/** References the per-fact selection leaves to section collection, as
 * `referencing unit -> defining unit` with the symbols. Recorded from the
 * pack when the check was added; a reason is given where one was
 * established, and the others are listed as found (tracked for review).
 * `(the program)` is a symbol the compiler emits into the program's own
 * object. */
const KNOWN_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  "scr_builtin_values.c -> scr_symbol.c": ["scr_dyn_new_symbol", "scr_sym_new", "scr_sym_release"],
  "scr_dyn_builtin_stream.c -> scr_stream_dyn.c": ["scr_stream_dyn_native"],
  "scr_dyn_handle_props.c -> scr_async_dyn.c": ["scr_dyn_promise_resolve"],
  "scr_dyn_handle_props.c -> scr_dyn_invoke.c": [
    "scr_dyn_define_props",
    "scr_dyn_define_props_pending",
    "scr_dyn_inherited_read",
  ],
  "scr_ecdh.c -> scr_async_dyn.c": ["scr_emit_warning"],
  "scr_event_target.c -> scr_async_dyn.c": ["scr_dyn_new_promise", "scr_promise_resolve_dyn"],
  // events.on reads a receiver's pause()/resume() through scr_dyn_invoke:
  // that is reached only from its libCalls, which the dynInvoke feature
  // selects. An AbortSignal alone links scr_event_target.c without it. Its
  // symbol keys are scr_symbol.c's, which every feature selecting the unit
  // requires (LINK_FEATURE_REQUIREMENTS).
  "scr_event_target.c -> scr_dyn_invoke.c": ["scr_dyn_invoke"],
  // process.finalization's one-per-feature ExperimentalWarning asks the
  // deferred warning queue, and every call that reaches the finalization
  // registration selects dynAsync (runtime-features.ts). An events program
  // without the registration (a held procStream type) links neither.
  "scr_events.c -> scr_async_dyn.c": ["scr_warning_emit_deferred", "scr_warning_new"],
  // createSecureServer and connect's TLS path: every http2.* call selects
  // the tls units, and a held session or stream type reaches neither.
  // The checked-data writes with a mode, a flag or an options record
  // (scr_fs_write_file_flags_data, scr_fs_write_file_data_options,
  // scr_fs_append_file_data_options, and their dynamic-mode twins) call the
  // string and byte writers of scr_fs_flags.c: every call that reaches them
  // (fs.writeFileSyncDataFlags, fsp.writeFileDataFlags,
  // fs.writeFileDataOptionsSync, fs.appendFileDataOptionsSync, and the
  // DynMode forms) selects fsFlags as well as fsBytesWrites.
  "scr_fs_bytes_write.c -> scr_fs_flags.c": [
    "scr_fs_append_file_bytes_options",
    "scr_fs_append_file_bytes_options_dyn_mode",
    "scr_fs_append_file_options",
    "scr_fs_append_file_options_dyn_mode",
    "scr_fs_write_file_bytes_options",
    "scr_fs_write_file_bytes_options_dyn_mode",
    "scr_fs_write_file_flags",
    "scr_fs_write_file_options",
    "scr_fs_write_file_options_dyn_mode",
  ],
  "scr_http2.c -> scr_tls.c": [
    "scr_https_create_server",
    "scr_tls_h2_client_wrap",
    "scr_tls_server_wrap_h2",
    "scr_tls_srv_opts_walk",
  ],
  "scr_js_wrapper.c -> scr_dyn_invoke.c": ["scr_dyn_invoke", "scr_dyn_object_tag_of"],
  "scr_json.c -> scr_dyn_invoke.c": ["scr_dyn_inherited_read"],
  // crypto.fipsGet reports DEP0093 through scr_emit_warning; every call
  // that reaches it (the deprecated crypto.fips read) selects the
  // dyn-async unit as well.
  "scr_pki.c -> scr_async_dyn.c": [
    "scr_emit_warning",
    "scr_warning_emit_deferred",
    "scr_warning_new",
  ],
  // readline reading from a stream: creating the interface (rl.create)
  // selects the events units.
  "scr_stream.c -> scr_readline.c": [
    "scr_rl_input_bytes",
    "scr_rl_input_end",
    "scr_rl_input_error",
    "scr_rl_input_str",
    "scr_rl_open",
    "scr_rl_ui_open",
  ],
  // emitKeypressEvents over a stream: rl.keypressStream selects the events
  // and regex units.
  "scr_stream.c -> scr_readline_tty.c": ["scr_rl_keypress_events"],
  "scr_stream.c -> scr_stream_ops.c": ["scr_stream_from_dyn_iter"],
  // A failing test's message: every test.* call selects the inspect unit,
  // and a held TestContext type reaches neither.
  "scr_test.c -> scr_inspect.c": ["scr_insp_dyn", "scr_insp_str"],
  // The module tables the compiler emits into a program that uses
  // WebAssembly (backend/llvm/wasm-modules.ts).
  "scr_wasm.c -> (the program)": ["scr_wasm_registry", "scr_wasm_untranslated"],
  "scr_webstreams.c -> scr_inspect.c": ["scr_insp_dyn_format_s"],
};

interface Symbols {
  defined: Set<string>;
  undefined: Set<string>;
}

const symbolCache = new Map<string, Symbols>();
function symbolsOf(path: string): Symbols {
  let symbols = symbolCache.get(path);
  if (symbols !== undefined) return symbols;
  symbols = { defined: new Set(), undefined: new Set() };
  const out = execFileSync("nm", ["-g", path], { encoding: "utf8", maxBuffer: 1 << 28 });
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // `U name` is a strong undefined reference; a defined symbol carries an
    // address column. Weak references (`w`, `v`) may stay unresolved.
    if (fields.length === 2 && fields[0] === "U") symbols.undefined.add(fields[1]!);
    else if (fields.length === 3) symbols.defined.add(fields[2]!);
  }
  symbolCache.set(path, symbols);
  return symbols;
}

const loc = { file: "fact.ts", start: 0, end: 1 };
function moduleOf(body: IrModule["functions"][number]["body"], localType?: IrType): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "%main",
    functions: [
      {
        name: "%main",
        params: [],
        returnType: { kind: "void" },
        locals:
          localType === undefined
            ? []
            : [{ id: "held.0", name: "held", type: localType, mutable: false }],
        body,
        loc,
      },
    ],
  };
}

/** One module per fact: a handle type held and never used, or one libCall
 * with placeholder arguments. */
function facts(): { label: string; mod: IrModule }[] {
  const out: { label: string; mod: IrModule }[] = [];
  const leafKinds = [...HANDLE_KINDS, "regex", "url", "searchParams", "symbol", "bigint"] as const;
  for (const kind of [...leafKinds].sort())
    out.push({ label: `type ${kind}`, mod: moduleOf([], { kind } as IrType) });
  const signatures = libFnSignatures() as Record<string, { params?: readonly unknown[] }>;
  for (const fn of Object.keys(signatures).sort()) {
    const count = Math.max(signatures[fn]?.params?.length ?? 0, 6);
    const args: IrExpr[] = Array.from({ length: count }, () => ({
      kind: "numLit",
      value: 0,
      type: { kind: "f64" },
      loc,
    }));
    const call = { kind: "libCall", fn, args, type: { kind: "void" }, loc } as IrExpr;
    out.push({ label: `call ${fn}`, mod: moduleOf([{ kind: "exprStmt", expr: call, loc }]) });
  }
  return out;
}

test.runIf(available)(
  "a runtime unit references only units its link features select, or a known reference",
  () => {
    const manifest = JSON.parse(
      readFileSync(join(packDir!, "runtime-pack.json"), "utf8"),
    ) as RuntimePackManifest;
    const flavor = manifest.flavors.release!;
    // The unit that defines a symbol: in its first build, or else in any
    // other build of a unit (read only for a symbol the first builds lack).
    const owners = new Map<string, string>();
    let everyBuildRead = false;
    const record = (source: string, path: string): void => {
      for (const name of symbolsOf(join(packDir!, path)).defined)
        if (!owners.has(name)) owners.set(name, source);
    };
    for (const unit of flavor.runtime_units) record(unit.source, unit.variants[0]!.path);
    const ownerOf = (name: string): string => {
      if (!owners.has(name) && !everyBuildRead) {
        everyBuildRead = true;
        for (const unit of flavor.runtime_units)
          for (const variant of unit.variants) record(unit.source, variant.path);
      }
      return owners.get(name) ?? "(the program)";
    };

    // Facts that derive the same link features select the same objects.
    const featureSets = new Map<
      string,
      { features: ReturnType<typeof executableLinkFeatures>; labels: string[] }
    >();
    for (const { label, mod } of facts()) {
      const features = executableLinkFeatures(mod);
      const key = Object.entries(features)
        .filter(([, on]) => on === true)
        .map(([name]) => name)
        .sort()
        .join("+");
      const set = featureSets.get(key);
      if (set === undefined) featureSets.set(key, { features, labels: [label] });
      else set.labels.push(label);
    }
    expect(featureSets.size).toBeGreaterThan(50);

    const found = new Map<string, { symbols: Set<string>; example: string }>();
    for (const [key, { features, labels }] of featureSets) {
      const selected = selectRuntimePackArtifacts(manifest, features, "release", {});
      const defined = new Set<string>();
      for (const artifact of [...selected.runtime, ...selected.archives])
        for (const name of symbolsOf(join(packDir!, artifact.path)).defined) defined.add(name);
      for (const { source, variant } of selectedRuntimeUnits(flavor, selected.features)) {
        for (const name of symbolsOf(join(packDir!, variant.path)).undefined) {
          if (!name.startsWith("scr_") || defined.has(name)) continue;
          const edge = `${source} -> ${ownerOf(name)}`;
          let entry = found.get(edge);
          if (entry === undefined) {
            entry = { symbols: new Set(), example: `${labels[0]} (links ${key || "no feature"})` };
            found.set(edge, entry);
          }
          entry.symbols.add(name);
        }
      }
    }

    const problems: string[] = [];
    for (const [edge, { symbols, example }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      const known = new Set(KNOWN_REFERENCES[edge] ?? []);
      const unexpected = [...symbols].filter((name) => !known.has(name)).sort();
      if (unexpected.length === 0) continue;
      const [source, definer] = edge.split(" -> ");
      problems.push(
        `${source} references ${unexpected.join(", ")} of ${definer}, which a program with only \`${example}\` does not link. If ${source} cannot link without ${definer}, add the requirement to LINK_FEATURE_REQUIREMENTS (packages/compiler/src/backend/native-link-info-core.ts). If the reference is reached only from a call that also selects ${definer}, add the symbols to KNOWN_REFERENCES["${edge}"] here with that reason.`,
      );
    }
    for (const [edge, names] of Object.entries(KNOWN_REFERENCES)) {
      const symbols = found.get(edge)?.symbols ?? new Set<string>();
      const gone = names.filter((name) => !symbols.has(name));
      if (gone.length > 0)
        problems.push(
          `KNOWN_REFERENCES["${edge}"] lists ${gone.join(", ")}, which the pack no longer leaves unresolved: delete ${gone.length === names.length ? "the entry" : "those symbols"}.`,
        );
    }
    expect(problems).toEqual([]);
  },
);
