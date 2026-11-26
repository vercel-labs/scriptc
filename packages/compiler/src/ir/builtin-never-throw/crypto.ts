import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the crypto module decided never to throw. */
export const cryptoNeverThrow: readonly IrLibFn[] = [
  // scr_crypto_x509_key_usage reads the certificate's extended key usage
  // extension: a certificate without one answers undefined and a malformed
  // extension is skipped, so no program-visible error is raised.
  "crypto.x509KeyUsage",
  // parsePKCS12's parts accessors read the handle the parse itself built:
  // an absent key or certificate answers null or empty bytes, and an index
  // past the additional certificates answers empty bytes.
  "crypto.pkcs12Key",
  "crypto.pkcs12Der",
  "crypto.pkcs12Count",
];
