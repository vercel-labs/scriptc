import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the crypto module decided never to throw. */
export const cryptoNeverThrow: readonly IrLibFn[] = [
  // scr_crypto_x509_key_usage reads the certificate's extended key usage
  // extension: a certificate without one answers undefined and a malformed
  // extension is skipped, so no program-visible error is raised.
  "crypto.x509KeyUsage",
];
