import { arrayOf, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The tlsca builtin call slots. */
export const tlscaSignatures = defineLibFnSignatures({
  // The CA-store introspection unit (scr_tls_ca.c): per-type cached PEM
  // string arrays and the default-set replacement.
  /** The CA-store introspection surface (scr_tls_ca.c — its own unit and
   * link gate, "tlsca." NOT "tls.", so a getCACertificates-only binary
   * never pulls mbedTLS): tlsca.get is tls.getCACertificates(type) — the
   * cached per-type string[] of PEM blocks (identity-stable across calls,
   * Node's caching; an unknown type throws Node's ERR_INVALID_ARG_VALUE
   * TypeError); tlsca.root is the tls.rootCertificates value read;
   * tlsca.set is tls.setDefaultCACertificates(certs) — replaces the
   * default set (deduped) and the anchors the TLS client verifies
   * against, throwing Node's ERR_CRYPTO_OPERATION_FAILED when no entry
   * carries a certificate block. */
  "tlsca.get": { argTypes: [STRING], result: arrayOf(STRING) },
  "tlsca.root": { argTypes: [], result: arrayOf(STRING) },
  "tlsca.set": { argTypes: [arrayOf(STRING)], result: VOID },
});
