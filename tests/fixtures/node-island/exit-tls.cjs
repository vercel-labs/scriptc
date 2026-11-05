// Island work that keeps OpenSSL busy while the program exits
// (exit-tls.mjs): loading node:tls starts Node's off-thread loading of the
// root certificates (system ones with NODE_USE_SYSTEM_CA=1, extra ones with
// NODE_EXTRA_CA_CERTS); pbkdf2 and key generation run on libuv's pool.
"use strict";
const crypto = require("node:crypto");
const tls = require("node:tls");

exports.warm = function warm(mode) {
  if (mode === "load") return tls.DEFAULT_MIN_VERSION.length > 0;
  tls.createSecureContext();
  const roots = tls.rootCertificates.length > 0;
  for (let i = 0; i < 8; i++) crypto.pbkdf2("password", "salt", 20000, 64, "sha512", () => {});
  if (mode === "keys") crypto.generateKeyPair("ec", { namedCurve: "P-256" }, () => {});
  return roots;
};
