// The real jose@6.2.12 through its root entry, from TypeScript, the way a
// Next.js proxy uses it: `import { jwtVerify, errors } from "jose"`.
// node_modules/jose vendors the published package's dist/ (every webapi
// module the root entry loads, and its declarations), package.json and
// LICENSE.md unmodified (MIT). Loading the root runs jwks/remote.js, which
// reads Node's navigator global at module load. Covers chained SignJWT
// builders, string durations (jose's secs()), destructured jwtVerify
// results and `instanceof errors.JOSEError` brand checks.
import { SignJWT, jwtVerify, errors, cryptoRuntime, decodeJwt } from "jose";

const encoder = new TextEncoder();
const secret = encoder.encode("scriptc-jose-root-shared-secret");
const now = 1_800_000_000;
const iat = 1_799_999_000;

interface Options {
  issuer?: string;
  audience?: string;
  algorithms?: string[];
  at?: number;
  maxTokenAge?: string;
  clockTolerance?: string;
}

async function check(label: string, token: string, options: Options = {}): Promise<void> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secret, {
      algorithms: options.algorithms ?? ["HS256"],
      currentDate: new Date((options.at ?? now) * 1000),
      issuer: options.issuer,
      audience: options.audience,
      maxTokenAge: options.maxTokenAge,
      clockTolerance: options.clockTolerance,
    });
    const role = payload.role;
    console.log(label, "ok", protectedHeader.alg, payload.sub ?? null, role, payload.exp ?? null);
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      console.log(label, error.code, error.message, error instanceof errors.JWTExpired);
    } else if (error instanceof TypeError) {
      console.log(label, "TypeError", error.message);
    } else {
      throw error;
    }
  }
}

console.log(cryptoRuntime, errors.JWTExpired.code, errors.JWSSignatureVerificationFailed.code);

const token = await new SignJWT({ role: "admin" })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuedAt(iat)
  .setIssuer("urn:scriptc:issuer")
  .setAudience("urn:scriptc:audience")
  .setSubject("alice")
  .setJti("jti-1")
  .setNotBefore(iat - 60)
  .setExpirationTime(iat + 3600)
  .sign(secret);
console.log(token);
console.log(JSON.stringify(decodeJwt(token)));

await check("valid", token, { issuer: "urn:scriptc:issuer", audience: "urn:scriptc:audience" });
await check("issuer", token, { issuer: "urn:other" });
await check("audience", token, { audience: "urn:other" });
await check("expired", token, { at: iat + 7200 });
await check("wrong secret", await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: "HS256" }).sign(encoder.encode("x")));
await check("malformed", "not.a.jwt");
await check("alg", token, { algorithms: ["HS512"] });

// String durations: maxTokenAge and clockTolerance against the fixed date.
await check("max age 10 minutes", token, { maxTokenAge: "10 minutes" });
await check("max age 1 hour", token, { maxTokenAge: "1 hour" });
await check("max age 2 days", token, { maxTokenAge: "2 days" });
await check("max age 1.5h", token, { maxTokenAge: "1.5h" });
await check("max age +20m", token, { maxTokenAge: "+20m" });
await check("max age 1 week", token, { maxTokenAge: "1 week" });
await check("max age 1y", token, { maxTokenAge: "1y" });
await check("max age 900 secs", token, { maxTokenAge: "900 secs" });
await check("max age 3 HOURS", token, { maxTokenAge: "3 HOURS" });
await check("tolerance 30s", token, { at: iat + 3620, clockTolerance: "30s" });
await check("tolerance 5 sec", token, { at: iat + 3620, clockTolerance: "5 sec" });
await check("tolerance 1 min from now", token, { at: iat + 3620, clockTolerance: "1 min from now" });
await check("tolerance 1 min ago", token, { at: iat + 3620, clockTolerance: "1 min ago" });
await check("bad duration", token, { maxTokenAge: "10 fortnights" });
await check("signed ago", token, { maxTokenAge: "-2h ago" });
await check("empty duration", token, { maxTokenAge: "" });

// String durations on the builder are relative to the clock: check the
// distance from now instead of printing it.
const relative = await new SignJWT({ role: "reader" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt("-1 minute")
  .setNotBefore("0s")
  .setExpirationTime("2h")
  .sign(secret);
const claims = decodeJwt(relative);
const clock = Math.floor(Date.now() / 1000);
console.log(
  Math.abs((claims.exp ?? 0) - clock - 7200) <= 2,
  Math.abs((claims.iat ?? 0) - clock + 60) <= 2,
  Math.abs((claims.nbf ?? 0) - clock) <= 2,
);
const { payload } = await jwtVerify(relative, secret, { maxTokenAge: "5 minutes" });
console.log(payload.role);
try {
  new SignJWT({}).setExpirationTime("soon");
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
