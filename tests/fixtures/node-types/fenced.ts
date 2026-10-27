/* Surface @types/node DECLARES but scriptc does not lower. Every use
 * typechecks (that is @types/node's job) and must FAIL COMPILATION with
 * the SC2020-family fence naming @types/node instead of a raw TS error
 * or a binary that runs with the wrong behavior. */
console.log(process.hasUncaughtExceptionCaptureCallback()); // the process introspection statics lower now; the capture-callback probe does not
/* setInterval lowers, and under @types/node its Timeout RETURN now maps
 * to the numeric handle — holding one and unref()/ref()/hasRef()/refresh()
 * all compile. The Timeout surface BEYOND that (close, [Symbol.toPrimitive],
 * ...) keeps the fence. */
const timer = setInterval(() => {
  console.log("tick");
}, 1000);
timer.unref();
timer.refresh();
timer.close();
/* The web-platform globals ride in with @types/node (undici). Fetch,
 * AbortController, and a typed RequestInit lower; wider Response members
 * below retain their profile fences. */
const fetchInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};
fetch("https://example.invalid/", fetchInit);
async function inspectResponse(url: string): Promise<void> {
  const response = await fetch(url);
  console.log(response.type);
  response.clone();
}
void inspectResponse;
ReadableStream.from(new Set([1, 2]));
/* Members of SUPPORTED builtin modules beyond the lowered tables: they
 * typecheck under @types/node and fence with the module-qualified name —
 * calls and value reads alike. */
import { watchFile } from "fs";
import { EventEmitter, on } from "node:events";
import { win32 } from "path";
watchFile("x", () => {});
on(new EventEmitter(), "tick");
console.log(win32.sep);
/* URL getters and serialization lower under @types/node, but object-URL
 * registry operations still fence by member name with the supported
 * list; searchParams and its method surface lower under
 * @types/node's declarations (provenance-mapped like URL itself). */
const u = new URL("https://example.com/x?a=1");
console.log(URL.createObjectURL(new Blob(["data"])));
u.searchParams.get("a");
/* The one-shot zlib/raw/gzip and Brotli codecs take Node's options (the
 * deflateSync and brotliCompressSync calls lower). */
import { brotliCompressSync, deflateSync } from "zlib";
deflateSync("data", { level: 9, strategy: 1 });
brotliCompressSync(Buffer.from("data"));
/* The http2 compatibility slice's @types/node-world fences (divergence
 * 56): the SNICallback option fences by name with the serve-one-pair
 * hint, and its conditional-spread portless spelling fences at the
 * spread (a computed spread — only inline object literals flatten); a
 * NON-literal h2 session-tuning value fences (literals are accepted and
 * ignored — no h2 session exists to tune); connect names the client gap
 * with the fallback in the hint. */
import * as http2 from "node:http2";
http2.createSecureServer({ allowHTTP1: true, cert: "pem", key: "pem", SNICallback: undefined });
http2.createSecureServer({
  allowHTTP1: true,
  cert: "pem",
  key: "pem",
  ...(1 ? { SNICallback: undefined } : {}),
});
http2.createSecureServer({ allowHTTP1: true, cert: "pem", key: "pem", streamResetBurst: 1 + 0 });
http2.connect("https://localhost");
/* The crypto surface beyond the lowered slice (randomness, the hash
 * chain, the introspection statics): RSA encryption names the lowered
 * asymmetric surface, symmetric ciphers the missing cipher stack, the
 * secure heap the generic hint, and setFips the FIPS truth (getFips() lowers to 0). */
import { createCipheriv, publicEncrypt, secureHeapUsed, setFips } from "node:crypto";
publicEncrypt("key", Buffer.alloc(1));
createCipheriv("aes-128-ocb", Buffer.alloc(16), Buffer.alloc(12), { authTagLength: 16 });
secureHeapUsed();
setFips(false);
fetch("https://example.invalid/", {
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});
async function inspectReadableStream(url: string): Promise<void> {
  const body = (await fetch(url)).body!;
  body.tee();
  const tee = body.tee;
  body["tee"]();
  const bracketTee = body["tee"];
}
void inspectReadableStream;
/* The one- and zero-argument util.callbackify overloads type the
 * callback's error as non-null, but Node calls back with null. */
import { callbackify } from "node:util";
const callbackified = callbackify(async (n: number) => n);
void callbackified;
/* ECDH on a curve Node knows but the runtime does not implement, and
 * computeSecret(view, encoding), which answers a Buffer where @types/node
 * declares a string. */
import { createECDH } from "node:crypto";
createECDH("sect163k1");
createECDH("prime256v1").computeSecret(Buffer.alloc(65), "hex");
/* DiffieHellman's Object.prototype members. */
import { createDiffieHellman } from "node:crypto";
createDiffieHellman(Buffer.from([23])).toString();
/* WebCrypto beyond the secret-key slice: @types/node declares the whole
 * SubtleCrypto surface, and the methods outside the slice, such as
 * getPublicKey, fence by name. */
async function publicKeyWithWebCrypto(key: import("node:crypto").webcrypto.CryptoKey): Promise<void> {
  await crypto.subtle.getPublicKey(key, ["verify"]);
}
void publicKeyWithWebCrypto;
/* Node's navigator global: navigator.locks (the Web Locks API) fences
 * by name. */
const locks = navigator.locks;
void locks;
// End of the declared-but-not-lowered surface.
