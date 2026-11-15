// Every argument count crypto.sign, crypto.verify, crypto.createSign and
// crypto.createVerify accept. Node checks the arguments a call supplies and
// answers the error of the check a missing one fails; a surplus argument
// evaluates in source order and is ignored; and a callback argument that is
// undefined at run time selects the synchronous form, while a function
// selects the asynchronous one and every other value is an argument error.
const crypto = require("node:crypto");

function show(label, run) {
  try {
    const value = run();
    console.log(label, "=>", Buffer.isBuffer(value) ? `buffer ${value.length}` : String(value));
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicExponent: 3,
});
const data = Buffer.from("call shapes");
const signature = crypto.sign("sha256", data, privateKey);
const undef = undefined;

// A missing argument reaches the check that reads it, in Node's order.
show("sign no arguments", () => crypto.sign());
show("sign algorithm only", () => crypto.sign("sha256"));
show("sign without key", () => crypto.sign("sha256", data));
show("sign undefined key", () => crypto.sign("sha256", data, undefined));
show("sign null algorithm", () => crypto.sign(null, data, privateKey));
show("verify no arguments", () => crypto.verify());
show("verify algorithm only", () => crypto.verify("sha256"));
show("verify without key", () => crypto.verify("sha256", data));
show("verify without signature", () => crypto.verify("sha256", data, publicKey));
show("verify undefined signature", () => crypto.verify("sha256", data, publicKey, undefined));

// The callback position: undefined at run time is no callback, a function
// defers the job, and every other value is an argument error before any
// job is queued.
show("sign undefined callback literal", () => crypto.sign("sha256", data, privateKey, undefined));
show("sign undefined callback value", () => crypto.sign("sha256", data, privateKey, undef));
show("verify undefined callback literal", () =>
  crypto.verify("sha256", data, publicKey, signature, undefined),
);
show("verify undefined callback value", () =>
  crypto.verify("sha256", data, publicKey, signature, undef),
);
show("sign null callback", () => crypto.sign("sha256", data, privateKey, null));
show("sign string callback", () => crypto.sign("sha256", data, privateKey, "callback"));
show("verify number callback", () => crypto.verify("sha256", data, publicKey, signature, 0));

// Surplus arguments evaluate in source order before the call and are
// ignored, even when the call itself throws.
const order = [];
function note(label, value) {
  order.push(label);
  return value;
}
show("sign surplus", () =>
  crypto.sign("sha256", data, privateKey, undefined, note("sign-five", 5), note("sign-six", 6)),
);
console.log("sign surplus order", order.join(","));
order.length = 0;
show("verify surplus", () =>
  crypto.verify("sha256", data, publicKey, signature, undefined, note("verify-six", 6)),
);
console.log("verify surplus order", order.join(","));
order.length = 0;
show("sign bad callback with surplus", () =>
  crypto.sign("sha256", data, privateKey, "not a function", note("bad-callback", 1)),
);
console.log("bad callback order", order.join(","));

// createSign and createVerify ignore surplus arguments too.
show("createSign surplus", () => {
  const signer = crypto.createSign("sha256", { dsaEncoding: "der" }, note("create-sign", 3));
  signer.update(data);
  return signer.sign(privateKey).length;
});
console.log("createSign surplus order", order.join(","));
order.length = 0;
show("createVerify surplus", () => {
  const verifier = crypto.createVerify("sha256", {}, note("create-verify", 3));
  verifier.update(data);
  return verifier.verify(publicKey, signature);
});
console.log("createVerify surplus order", order.join(","));

// The algorithm is required by name and by type.
show("createSign without algorithm", () => crypto.createSign());
show("createSign undefined algorithm", () => crypto.createSign(undefined));
show("createSign number algorithm", () => crypto.createSign(5));
show("createVerify without algorithm", () => crypto.createVerify());
show("createVerify unknown algorithm", () => crypto.createVerify("not-a-digest"));

// The asynchronous forms deliver after the synchronous code that queued
// them, and their surplus arguments evaluated before that code ended. Each
// step queues the next from its callback, so the delivery order is the
// nested order rather than the thread pool's.
const asyncOrder = [];
let synchronous = true;
crypto.sign(
  "sha256",
  data,
  privateKey,
  (err, asyncSignature) => {
    asyncOrder.push(
      `sign ${err} ${Buffer.isBuffer(asyncSignature)} ${asyncSignature.length} ${synchronous}`,
    );
    crypto.verify("sha256", data, publicKey, asyncSignature, (verifyErr, ok) => {
      asyncOrder.push(`verify ${verifyErr} ${ok} ${synchronous}`);
      crypto.verify(
        "sha256",
        data,
        publicKey,
        signature,
        (surplusErr, surplusOk) => {
          asyncOrder.push(`surplus ${surplusErr} ${surplusOk}`);
          console.log("async order", asyncOrder.join(" | "), synchronous, order.join(","));
        },
        note("verify-five", 5),
        note("verify-six", 6),
      );
    });
  },
  note("async-five", 5),
  note("async-six", 6),
);
console.log("async surplus order", order.join(","));
order.length = 0;
synchronous = false;
console.log("sync end", order.join(","));
