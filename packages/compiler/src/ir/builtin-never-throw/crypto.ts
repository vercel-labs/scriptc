import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the crypto module decided never to throw. */
export const cryptoNeverThrow: readonly IrLibFn[] = [
  "crypto.x509KeyUsage",
  // scr_crypto_x509_key_usage reads the certificate's extended key usage
  // extension: a certificate without one answers undefined and a malformed
  // extension is skipped, so no program-visible error is raised.
  // crypto.getFips reads the process flag: no validation, no program code.
  "crypto.getFips",
];
