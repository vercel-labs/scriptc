/* Surface @types/node DECLARES but scriptc does not lower. Every use
 * typechecks (that is @types/node's job) and must FAIL COMPILATION with
 * the SC2020-family fence naming @types/node — never a raw TS error,
 * never a silently broken binary. */
console.log(process.memoryUsage()); // uptime/cpuUsage/resourceUsage lower now; the V8-heap report does not
const buf = Buffer.from("bytes").readBigUInt64BE(0); // from, fill, and the numeric families lower; the bigint reads fence
console.log(Buffer.poolSize);
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
import { cpus } from "node:os";
import { win32 } from "path";
watchFile("x", () => {});
console.log(cpus().length);
console.log(win32.sep);
/* URL members beyond the supported getters (protocol/pathname/href/
 * host/hostname/search/searchParams) fence member-qualified, with the
 * supported list; searchParams and its method surface LOWER under
 * @types/node's declarations (provenance-mapped like URL itself). */
const u = new URL("https://example.com/x?a=1");
console.log(u.hash);
u.searchParams.get("a");
/* The zlib surface beyond the lowered deflateSync/inflateSync pair
 * fences with the pair named; the lowered pair itself takes Buffers, so a
 * string argument (which @types/node admits) gets the wrap-it-first
 * hint. */
import { deflateSync, gzipSync } from "zlib";
deflateSync("data");
gzipSync("data");
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
 * chain, the introspection statics): asymmetric-key operations name the
 * missing public-key stack, symmetric ciphers the missing cipher stack,
 * KDFs their family, and setFips the FIPS truth (getFips() lowers to 0). */
import { createCipheriv, generateKeyPair, pbkdf2Sync, setFips } from "node:crypto";
generateKeyPair("rsa", { modulusLength: 2048 }, () => {});
createCipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(16));
pbkdf2Sync("pw", "salt", 100000, 64, "sha512");
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
// End of the declared-but-not-lowered surface.
