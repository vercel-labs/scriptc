// crypto.constants as an object under @types/node, which declares it as a
// namespace of constants rather than an interface: the object's type is
// that namespace. Node's object carries the full table (the pinned @types
// omits the four TLS1_* names, and the program does not name them), so the
// compiled singleton's key list is Node's. OPENSSL_VERSION_NUMBER's value
// stays out of the aggregates: the compiled table carries the pinned
// Node's value, and a 24.22 build with another OpenSSL patch level answers
// a different one.
import * as crypto from "node:crypto";
import { constants } from "node:crypto";

const EXTRA: string = "OPENSSL_VERSION_NUMBER";
const table: typeof constants = crypto.constants;
console.log("typeof", typeof table, typeof table.OPENSSL_VERSION_NUMBER);
console.log("same", table === constants, table === crypto.constants, table === crypto["constants"]);

const keys = Object.keys(table);
console.log("keys", keys.length, keys[0], keys[1], keys[keys.length - 1]);

const copy = { ...table };
console.log("spread", Object.keys(copy).length, copy.SSL_OP_ALL, copy.defaultCipherList.length);

console.log("literal", table.SSL_OP_ALL, table.ENGINE_METHOD_ALL, table.RSA_PSS_SALTLEN_DIGEST);
console.log("strings", typeof table.defaultCipherList, table.defaultCipherList.length);
const { SSL_OP_NO_TICKET, defaultCoreCipherList } = crypto.constants;
console.log("destructured", SSL_OP_NO_TICKET, defaultCoreCipherList.length);

function bits(k: typeof constants): number {
  return k.SSL_OP_NO_TLSv1 + k.SSL_OP_NO_SSLv3;
}
console.log("parameter", bits(crypto.constants), bits({ ...table }));

let sum = 0;
let strings = 0;
for (const [key, value] of Object.entries(table)) {
  if (key === EXTRA) continue;
  if (typeof value === "string") strings++;
  else sum += value;
}
console.log("entries", sum, strings);
console.log("json", JSON.stringify({ SSL_OP_ALL: table.SSL_OP_ALL }));
