// X509Certificate keeps its fields as prototype getters, so Node's own-key
// walks over a certificate see none of them. The walks this file still
// refuses by name are spread and for-in; the own-key calls Node answers with
// an empty result are exercised by the X509 reflection corpus programs.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const cert = new X509Certificate(readFileSync("cert.pem"));
console.log({ ...cert });
for (const key in cert) console.log(key);

// A certificate in an unknown or any slot would cross as a plain object of
// its fields, which Node's certificate is not.
const held: unknown = cert;
console.log(held);
function describe(value: unknown): string {
  return typeof value;
}
console.log(describe([cert]));
