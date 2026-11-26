// crypto.generateKeyPair('dh', { primeLength }, callback): the safe-prime
// search keeps the event loop responsive (Node runs it on its threadpool),
// the callback is deferred, and the failures match Node's: message-only
// Errors from the generation, synchronous TypeErrors from the option checks.
import * as crypto from "node:crypto";

const describe = (error) =>
  JSON.stringify({
    name: error.name,
    code: error.code,
    library: error.library,
    reason: error.reason,
    message: error.message,
  });

let ticks = 0;
let synchronous = true;
const timer = setInterval(() => {
  ticks++;
}, 1);
const options = {
  primeLength: 512,
  generator: 2,
  privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "one" },
};
const pair = await new Promise((resolve, reject) => {
  crypto.generateKeyPair("dh", options, (error, publicKey, privateKey) => {
    if (error) reject(error);
    else resolve({ publicKey, privateKey, synchronous });
  });
  // The encodings are read when the call is made: changing them here (as a
  // request handler sharing the object might) must not affect the export.
  options.privateKeyEncoding.passphrase = null;
  options.privateKeyEncoding.type = "pkcs1";
  options.privateKeyEncoding.format = "der";
  synchronous = false;
});
clearInterval(timer);
console.log(
  "types",
  pair.publicKey.asymmetricKeyType,
  typeof pair.privateKey,
  String(pair.privateKey).split("\n")[0],
);
console.log("deferred", pair.synchronous === false);
console.log("timers", ticks > 0);

// A null encoding asks for the KeyObject itself, as an absent option does;
// a named group's key makes the same request without a prime to generate.
const nulls = await new Promise((resolve, reject) => {
  crypto.generateKeyPair(
    "dh",
    { group: "modp5", publicKeyEncoding: null, privateKeyEncoding: null },
    (error, publicKey, privateKey) =>
      error ? reject(error) : resolve(publicKey.asymmetricKeyType + privateKey.asymmetricKeyType),
  );
});
console.log("null encodings", nulls);

const failure = (options) =>
  new Promise((resolve) => {
    crypto.generateKeyPair("dh", options, (error) => resolve(describe(error)));
  });
console.log("too small", await failure({ primeLength: 511, generator: 2 }));
console.log("bad generator", await failure({ primeLength: 512, generator: 0 }));
const thrown = (options) => {
  try {
    crypto.generateKeyPair("dh", options, () => {});
    return "resolved";
  } catch (error) {
    return describe(error);
  }
};
console.log("no options", thrown({}));
console.log("group conflict", thrown({ group: "modp5", primeLength: 512 }));
console.log("prime conflict", thrown({ prime: crypto.getDiffieHellman("modp5").getPrime(), primeLength: 512 }));

// A generation failure reaches the callback; a generated prime takes any
// generator above 1, and an explicit prime takes 1 as well.
console.log("prime too small", await failure({ prime: Buffer.from("ffffffffffffffc5", "hex"), generator: 2 }));
const generatedFive = await new Promise((resolve, reject) => {
  crypto.generateKeyPair("dh", { primeLength: 512, generator: 5 }, (error, publicKey, privateKey) => {
    if (error) reject(error);
    else resolve(publicKey.asymmetricKeyType + privateKey.asymmetricKeyType);
  });
});
console.log("generated generator five", generatedFive);
const degenerate = await new Promise((resolve, reject) => {
  crypto.generateKeyPair("dh", { prime: crypto.getDiffieHellman("modp5").getPrime(), generator: 1 },
    (error, publicKey) => {
      if (error) reject(error);
      else resolve(publicKey.asymmetricKeyType + " " + publicKey.export({ type: "spki", format: "der" }).length);
    });
});
console.log("prime generator one", degenerate);
