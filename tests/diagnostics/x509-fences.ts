// X509Certificate keeps its fields as prototype getters, so Node's own-key
// walks over a certificate see none of them. Those walks are refused by
// name instead of listing the fields.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const cert = new X509Certificate(readFileSync("cert.pem"));
console.log(Object.keys(cert));
console.log(Object.entries(cert));
console.log({ ...cert });
console.log(Object.prototype.hasOwnProperty.call(cert, "subject"));
for (const key in cert) console.log(key);

// A certificate in an unknown or any slot would cross as a plain object of
// its fields, which Node's certificate is not.
const held: unknown = cert;
console.log(held);
function describe(value: unknown): string {
  return typeof value;
}
console.log(describe([cert]));
