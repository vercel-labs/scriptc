// ecdh.setPublicKey: DEP0031 once, on the next tick; a public key that is
// not d·G makes computeSecret throw ERR_CRYPTO_INVALID_KEYPAIR, a key with
// only a public part cannot compute a secret, and setPrivateKey replaces
// the public key again. The program re-runs itself and prints the child's
// output with process ids normalized.
"use strict";
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function child() {
  process.on("warning", (w) => console.log("warning", w.name, w.code, w.message));

  const a = crypto.createECDH("prime256v1");
  a.setPrivateKey(Buffer.from([2]));
  const pub = a.getPublicKey();

  function attempt(label, run) {
    try {
      const result = run();
      console.log(label, "ok", Buffer.isBuffer(result) ? result.toString("hex").slice(0, 16) : JSON.stringify(result));
    } catch (e) {
      console.log(label, e.name, e.code, e.message);
    }
  }

  const onlyPublic = crypto.createECDH("prime256v1");
  attempt("set public", () => onlyPublic.setPublicKey(pub) === onlyPublic);
  console.log("after set public (warning comes later)");
  attempt("public only: getPublicKey", () => onlyPublic.getPublicKey("hex").slice(0, 10));
  attempt("public only: getPrivateKey", () => onlyPublic.getPrivateKey());
  attempt("public only: computeSecret", () => onlyPublic.computeSecret(pub));

  const mismatch = crypto.createECDH("prime256v1");
  mismatch.setPrivateKey(Buffer.from([3]));
  attempt("mismatch: set public", () => mismatch.setPublicKey(pub) === mismatch);
  attempt("mismatch: computeSecret", () => mismatch.computeSecret(pub));
  attempt("mismatch: invalid point", () => mismatch.computeSecret(Buffer.alloc(3)));
  attempt("mismatch: setPrivateKey repairs", () => mismatch.setPrivateKey(Buffer.from([2])).computeSecret(pub));

  const matching = crypto.createECDH("prime256v1");
  matching.setPrivateKey(Buffer.from([2]));
  attempt("matching", () => matching.setPublicKey(pub, "buffer").computeSecret(pub));
  attempt("set public hex", () => matching.setPublicKey(pub.toString("hex"), "hex") === matching);
  attempt("set public invalid", () => matching.setPublicKey(Buffer.alloc(65, 4)));
  attempt("set public number", () => matching.setPublicKey(5));
  attempt("set infinity", () => matching.setPublicKey(Buffer.from([0])).getPublicKey("hex"));
  attempt("infinity: computeSecret", () => matching.computeSecret(pub));
  attempt("compressed public", () => crypto.createECDH("prime256v1").setPublicKey(a.getPublicKey(null, "compressed")).getPublicKey("hex").slice(0, 10));
  setTimeout(() => console.log("timer"), 0);
  console.log("end of script");
}

if (process.argv[2] === "child") {
  child();
} else {
  const run = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
