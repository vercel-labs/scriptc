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
const pair = await new Promise((resolve, reject) => {
  crypto.generateKeyPair("dh", { primeLength: 512, generator: 2 }, (error, publicKey, privateKey) => {
    if (error) reject(error);
    else resolve({ publicKey, privateKey, synchronous });
  });
  synchronous = false;
});
clearInterval(timer);
console.log("types", pair.publicKey.asymmetricKeyType, pair.privateKey.asymmetricKeyType);
console.log("deferred", pair.synchronous === false);
console.log("timers", ticks > 0);

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
