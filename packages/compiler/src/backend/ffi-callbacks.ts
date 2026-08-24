import { InternalCompilerError } from "../errors.js";
import type { IrFfiCallbackParam, IrFfiImport } from "../ir/ir.js";
import { isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam } from "../ir/ir.js";

export interface FfiCallbackAdapter {
  symbol: string;
  /** Raw call-scoped callbacks borrow this thread-local slot. */
  tls: string | null;
  /** Raw retained callbacks occupy this process-global replaceable slot. */
  global: string | null;
  /** Every retained descriptor owns one counted registration table. */
  table: string | null;
  callback: IrFfiCallbackParam["callback"];
}

/** Allocate internal callback symbols outside the manifest's external
 * symbol set. C and LLVM share this table so a valid native symbol can
 * never collide with a generated trampoline or raw-callback TLS slot. */
export function allocateFfiCallbackAdapters(
  imports: readonly IrFfiImport[],
): Map<string, FfiCallbackAdapter> {
  const reserved = new Set(imports.map((entry) => entry.symbol));
  const adapters = new Map<string, FfiCallbackAdapter>();
  let suffix = 0;

  for (const entry of imports) {
    for (const param of entry.params) {
      if (!isFfiCallbackParam(param)) continue;
      const hasContext = param.callback.params.some(isFfiContextParam);
      let symbol: string;
      let tls: string | null;
      let global: string | null;
      let table: string | null;
      do {
        const index = suffix++;
        symbol = `sc_ffi_cb_${index}`;
        tls = !hasContext && param.callback.lifetime === "call"
          ? `sc_ffi_cb_ctx_${index}`
          : null;
        global = !hasContext && param.callback.lifetime === "retained"
          ? `sc_ffi_cb_retained_${index}`
          : null;
        table = param.callback.lifetime === "retained"
          ? `sc_ffi_cb_table_${index}`
          : null;
      } while (
        reserved.has(symbol) ||
        (tls !== null && reserved.has(tls)) ||
        (global !== null && reserved.has(global)) ||
        (table !== null && reserved.has(table))
      );
      reserved.add(symbol);
      if (tls !== null) reserved.add(tls);
      if (global !== null) reserved.add(global);
      if (table !== null) reserved.add(table);
      adapters.set(`${entry.name}:${param.callback.id}`, {
        symbol,
        tls,
        global,
        table,
        callback: param.callback,
      });
    }
  }

  return adapters;
}

/** The adapter-map key is `<binding>:<callback-id>`; a release descriptor
 * carries the same key as its target. Binding names may themselves contain
 * `:`; callback ids may not — split on the LAST separator. The single
 * parser for every consumer (both emitters, twice each). */
export function parseFfiCallbackKey(key: string): { binding: string; id: string } {
  const split = key.lastIndexOf(":");
  return { binding: key.slice(0, split), id: key.slice(split + 1) };
}

/** Whether any manifest binding declares a retained callback — the
 * throw-checkpoint policy predicate (with retained descriptors ANY binding
 * may pump a stored callback). Computed once per module by may-throw and
 * each emitter; keep every consumer on this helper so the policy cannot
 * drift between analysis and emission. */
export function hasRetainedFfiCallback(imports: readonly IrFfiImport[]): boolean {
  return imports.some((entry) =>
    entry.params.some(
      (param) => isFfiCallbackParam(param) && param.callback.lifetime === "retained",
    ),
  );
}

/** Foreign callbacks install and hold the process event loop even when the
 * source itself has no timer, async function, or other loop-backed surface. */
export function hasForeignFfiCallback(imports: readonly IrFfiImport[]): boolean {
  return imports.some((entry) =>
    entry.params.some(
      (param) => isFfiCallbackParam(param) && param.callback.invoke === "foreign",
    ),
  );
}

/** One retained lifecycle operation of an FFI call: the registration table,
 * the raw singleton trampoline slot (null for context-bearing descriptors),
 * and the backend's value for the closure argument. */
export interface FfiRetainedOp<V> {
  table: string;
  global: string | null;
  callback: V;
  foreign: boolean;
}

/** Collect a call's retained registrations and releases in manifest order —
 * the lifecycle-policy walk shared by the C and LLVM emitters, so ordering
 * fixes apply to both backends at once. */
export function collectFfiRetainedOps<V>(
  entry: IrFfiImport,
  callbackArgs: ReadonlyMap<string, V>,
  adapterFor: (binding: string, id: string) => FfiCallbackAdapter,
): { registrations: FfiRetainedOp<V>[]; releases: FfiRetainedOp<V>[] } {
  const registrations: FfiRetainedOp<V>[] = [];
  const releases: FfiRetainedOp<V>[] = [];
  for (const param of entry.params) {
    if (isFfiCallbackParam(param) && param.callback.lifetime === "retained") {
      const adapter = adapterFor(entry.name, param.callback.id);
      if (adapter.table === null) throw new InternalCompilerError("emitter bug: retained callback has no table");
      registrations.push({
        table: adapter.table,
        global: adapter.global,
        callback: callbackArgs.get(param.callback.id)!,
        foreign: param.callback.invoke === "foreign",
      });
    } else if (isFfiReleaseParam(param)) {
      const { binding, id } = parseFfiCallbackKey(param.callback.release);
      const adapter = adapterFor(binding, id);
      if (adapter.table === null) throw new InternalCompilerError("emitter bug: retained release has no table");
      releases.push({
        table: adapter.table,
        global: adapter.global,
        callback: callbackArgs.get(param.callback.release)!,
        foreign: adapter.callback.invoke === "foreign",
      });
    }
  }
  return { registrations, releases };
}
