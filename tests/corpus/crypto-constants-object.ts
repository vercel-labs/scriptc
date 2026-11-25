// crypto.constants read as an object rather than member by member: Node's
// module answers one singleton whose keys are inserted in its own order.
// Read it whole (typeof, identity, keys, spread, entries, for-in, JSON),
// read it by name, destructure it, reach it through the bracket and
// namespace spellings, pass it to a function and use its members in a
// check.
// OPENSSL_VERSION_NUMBER's VALUE is skipped in the aggregate checks: the
// compiled table carries the pinned Node's value, another 24.22 build can
// carry a different OpenSSL patch level, so summing or printing it would
// make the program host-dependent. The name itself is always there.
import * as crypto from "node:crypto";
import { constants } from "node:crypto";

const EXTRA: string = "OPENSSL_VERSION_NUMBER";
const table: crypto.CryptoConstants = crypto.constants;
console.log("typeof", typeof crypto.constants, typeof table.OPENSSL_VERSION_NUMBER);
console.log(
  "same",
  crypto.constants === crypto.constants,
  crypto.constants === constants,
  table === crypto.constants,
);

// The bracket spellings and the namespace's destructuring answer the same
// singleton the property form does, and the namespace's own key list names
// it. A bracket read reaches the namespace box the compiler builds for a
// namespace read as a value, so the box must serve this member.
const byLiteral: crypto.CryptoConstants = crypto["constants"];
const key: "constants" = "constants";
const byKey: crypto.CryptoConstants = crypto[key];
const { constants: viaNamespace } = crypto;
console.log(
  "spellings",
  byLiteral === table,
  byKey === table,
  viaNamespace === table,
  viaNamespace.ENGINE_METHOD_ALL,
);
const namespaceKeys = Object.keys(crypto);
console.log("namespace keys", namespaceKeys.includes("constants"), namespaceKeys.length);

const keys = Object.keys(table);
console.log("keys", keys.length, keys[0], keys[1], keys[keys.length - 2], keys[keys.length - 1]);

const copy = { ...table };
const copyKeys = Object.keys(copy);
console.log(
  "spread",
  copyKeys.length,
  copy.SSL_OP_ALL,
  copy.RSA_PKCS1_PADDING,
  copy.defaultCipherList.length,
  copy === table,
);

console.log(
  "literal",
  table.SSL_OP_ALL,
  table.ENGINE_METHOD_ALL,
  table.ENGINE_METHOD_NONE,
  table.DH_UNABLE_TO_CHECK_GENERATOR,
  table.RSA_PKCS1_PADDING,
  table.RSA_PSS_SALTLEN_DIGEST,
  table.RSA_PSS_SALTLEN_MAX_SIGN,
);
console.log(
  "versions",
  table.TLS1_VERSION,
  table.TLS1_1_VERSION,
  table.TLS1_2_VERSION,
  table.TLS1_3_VERSION,
  table.POINT_CONVERSION_COMPRESSED,
  table.POINT_CONVERSION_HYBRID,
);
console.log(
  "cipher lists",
  typeof table.defaultCipherList,
  typeof table.defaultCoreCipherList,
  table.defaultCipherList.length,
  table.defaultCipherList === table.defaultCoreCipherList,
  table.defaultCipherList.slice(0, 24),
);

const { SSL_OP_NO_TICKET, RSA_NO_PADDING, TLS1_2_VERSION } = crypto.constants;
console.log("destructured", SSL_OP_NO_TICKET, RSA_NO_PADDING, TLS1_2_VERSION);

function bits(k: crypto.CryptoConstants): number {
  return k.SSL_OP_NO_TLSv1 + k.SSL_OP_NO_SSLv3 + k.TLS1_3_VERSION;
}
function list(k: crypto.CryptoConstants): string {
  return k.defaultCipherList.slice(0, 6);
}
console.log("parameter", bits(crypto.constants), bits({ ...table }), list(table));

let sum = 0;
let strings = 0;
let count = 0;
for (const [key, value] of Object.entries(table)) {
  count++;
  if (key === EXTRA) continue;
  if (typeof value === "string") strings++;
  else sum += value;
}
console.log("entries", count, sum, strings);

let seen = 0;
for (const key in table) seen++;
console.log("for-in", seen);
console.log("dynamic", table["TLS1_VERSION"], typeof table["POINT_CONVERSION_HYBRID"]);

console.log(
  "json",
  JSON.stringify({
    SSL_OP_ALL: table.SSL_OP_ALL,
    TLS1_3_VERSION: table.TLS1_3_VERSION,
    RSA_PSS_SALTLEN_DIGEST: table.RSA_PSS_SALTLEN_DIGEST,
  }),
);
