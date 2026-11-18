// The declared result of each crypto.sign and crypto.verify call shape.
// The synchronous form answers its value; a callback that is undefined at
// run time is no callback, so the call still answers synchronously; a
// callback that may be undefined answers the value when it runs
// synchronously and undefined when the job is deferred; and arguments past
// the callback position are accepted, evaluated and ignored, leaving the
// answer to the shape the earlier arguments select. The Sign and Verify
// classes answer through the same encodings.
import * as crypto from "node:crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicExponent: 3,
});
const data = Buffer.from("typed shapes");

const synchronous: Buffer = crypto.sign("sha256", data, privateKey);
console.log("sign sync", synchronous.length);

const undefinedCallback: Buffer = crypto.sign("sha256", data, privateKey, undefined);
console.log("sign undefined callback", undefinedCallback.equals(synchronous));

const verdict: boolean = crypto.verify("sha256", data, publicKey, synchronous);
console.log("verify sync", verdict);

const undefinedVerdict: boolean = crypto.verify("sha256", data, publicKey, synchronous, undefined);
console.log("verify undefined callback", undefinedVerdict);

let deferred = 0;
// The deferred verify is issued from the sign callback: both calls complete
// on the thread pool, and Node prints whichever completes first, so starting
// them together would make the printed order a race. One call at a time
// keeps the two answers (the synchronous return and the callback) pinned.
function verifyDeferred(): void {
  const deferredVerdict: boolean | void = crypto.verify(
    "sha256",
    data,
    publicKey,
    synchronous,
    maybeVerifyCallback,
  );
  console.log("deferred verify", typeof deferredVerdict === "boolean", deferredVerdict);
}
const callback = (err: Error | null, signature: Buffer): void => {
  deferred += 1;
  console.log("sign callback", err, signature.length, deferred);
  verifyDeferred();
};
const notified: void = crypto.sign("sha256", data, privateKey, callback);
console.log("sign async answers", notified);

let maybeCallback: ((err: Error | null, signature: Buffer) => void) | undefined = undefined;
const maybeSignature: Buffer | void = crypto.sign("sha256", data, privateKey, maybeCallback);
console.log(
  "maybe sign",
  Buffer.isBuffer(maybeSignature),
  Buffer.isBuffer(maybeSignature) ? maybeSignature.length : -1,
);
let maybeVerifyCallback: ((err: Error | null, result: boolean) => void) | undefined = undefined;
const maybeVerdict: boolean | void = crypto.verify(
  "sha256",
  data,
  publicKey,
  synchronous,
  maybeVerifyCallback,
);
console.log("maybe verify", typeof maybeVerdict === "boolean", maybeVerdict);
maybeVerifyCallback = (err: Error | null, result: boolean): void => {
  console.log("verify callback", err, result);
};

// Arguments past the callback position still leave the synchronous answer.
const long: Buffer | void = crypto.sign("sha256", data, privateKey, undefined, "surplus", 1);
console.log("sign surplus", Buffer.isBuffer(long), Buffer.isBuffer(long) ? long.length : -1);
const longVerdict: boolean | void = crypto.verify(
  "sha256",
  data,
  publicKey,
  synchronous,
  undefined,
  "surplus",
);
console.log("verify surplus", longVerdict);

// An ECDSA key answers DER by default and P1363 on request; the P1363
// signature is twice the curve size.
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ecDer: Buffer = crypto.sign("sha256", data, ec.privateKey);
const ecUndefined: Buffer = crypto.sign("sha256", data, ec.privateKey, undefined);
console.log(
  "ec",
  crypto.verify("sha256", data, ec.publicKey, ecDer),
  crypto.verify("sha256", data, ec.publicKey, ecUndefined),
);
const ecP1363: Buffer = crypto.sign("sha256", data, {
  key: ec.privateKey,
  dsaEncoding: "ieee-p1363",
});
console.log(
  "ec p1363",
  ecP1363.length,
  crypto.verify("sha256", data, { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, ecP1363),
  crypto.verify("sha256", data, ec.publicKey, ecP1363),
);

// Ed25519 signs with a null algorithm and a fixed 64-byte signature.
const ed = crypto.generateKeyPairSync("ed25519");
const edSignature: Buffer = crypto.sign(null, data, ed.privateKey);
const edUndefined: Buffer = crypto.sign(null, data, ed.privateKey, undefined);
console.log(
  "ed25519",
  edSignature.length,
  edUndefined.equals(edSignature),
  crypto.verify(null, data, ed.publicKey, edSignature),
);

// The streaming classes answer the same results as the one-shot forms.
const signer = crypto.createSign("sha256");
signer.update(data);
const streamed: Buffer = signer.sign(privateKey);
console.log("createSign", streamed.equals(synchronous));

const encodedSigner = crypto.createSign("sha256");
encodedSigner.update(data);
const encoded: string = encodedSigner.sign(privateKey, "base64");
console.log("createSign base64", encoded.length, encoded === synchronous.toString("base64"));

const verifier = crypto.createVerify("sha256");
verifier.update(data);
const streamedVerdict: boolean = verifier.verify(publicKey, streamed);
console.log("createVerify", streamedVerdict);

const encodedVerifier = crypto.createVerify("sha256");
encodedVerifier.update(data);
console.log("createVerify base64", encodedVerifier.verify(publicKey, encoded, "base64"));
// A Verify answers once: the second verdict reads a finished state.
try {
  console.log("createVerify twice", encodedVerifier.verify(publicKey, "AAAA"));
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("createVerify twice throws", err.name, err.code, err.message);
}
const wrongVerifier = crypto.createVerify("sha256");
wrongVerifier.update(data);
console.log("createVerify wrong", wrongVerifier.verify(publicKey, "AAAA"));
