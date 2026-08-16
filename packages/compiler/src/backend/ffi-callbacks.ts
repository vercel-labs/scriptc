import type { IrFfiCallbackParam, IrFfiImport } from "../ir/nodes.js";
import { isFfiCallbackParam, isFfiContextParam } from "../ir/nodes.js";

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
