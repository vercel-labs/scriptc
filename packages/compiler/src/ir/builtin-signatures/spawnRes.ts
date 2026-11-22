import { BYTES_U8, SPAWNRES_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The spawnRes builtin call slots. */
export const spawnResSignatures = defineLibFnSignatures({
  // Like process.envGet, spawnRes.status's result type is program-dependent
  // (the interned `number | null` union) — the libCall case checks the arms.
  "spawnRes.status": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.error's result is the interned `Error | undefined` union —
  // the libCall case checks the arms, the spawnRes.status pattern.
  /** Node's spawn-failure carrier `error?: Error`: a fresh +1 %Error
   * ("spawnSync <file> ENOENT", `code` stamped) when the spawn itself
   * failed, the interned undefined arm otherwise — the result type is the
   * call site's `Error | undefined` union, constructed type-directedly in
   * the backend (the envGet convention). Never throws. */
  "spawnRes.error": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.signal's result is the interned `string | null` union —
  // same pattern.
  "spawnRes.signal": { argTypes: [SPAWNRES_T], result: VOID },
  "spawnRes.stdout": { argTypes: [SPAWNRES_T], result: STRING },
  "spawnRes.stderr": { argTypes: [SPAWNRES_T], result: STRING },
  /* The Buffer captures (spawnSync without an encoding option): the same
   * stored bytes as a bytes<u8> value, branded under fsBufferBrand. */
  "spawnRes.stdoutBytes": { argTypes: [SPAWNRES_T], result: BYTES_U8 },
  "spawnRes.stderrBytes": { argTypes: [SPAWNRES_T], result: BYTES_U8 },
});
