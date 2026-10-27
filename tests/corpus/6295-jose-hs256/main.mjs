// The real jose@6.2.12 HS256 path: SignJWT and jwtVerify from jose's
// public jose/jwt/sign, jose/jwt/verify and jose/errors entry points, over
// crypto.subtle importKey, sign and verify. node_modules/jose vendors the
// dist/webapi files those entry points load and their declarations,
// unmodified (MIT, LICENSE.md), with a package.json that exports only
// those entry points.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import * as errors from "jose/errors";

const encoder = new TextEncoder();
const secret = encoder.encode("scriptc-jose-hs256-shared-secret");
const now = new Date(1_800_000_000_000);
const iat = 1_799_999_000;

async function sign(claims, alg = "HS256", key = secret) {
  const jwt = new SignJWT(claims);
  jwt.setProtectedHeader({ alg, typ: "JWT" });
  jwt.setIssuedAt(iat);
  jwt.setIssuer("urn:scriptc:issuer");
  jwt.setAudience("urn:scriptc:audience");
  jwt.setSubject("alice");
  return jwt.sign(key);
}

async function verify(label, token, options = {}, key = secret) {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      currentDate: now,
      ...options,
    });
    console.log(label, "ok", JSON.stringify(protectedHeader), JSON.stringify(payload));
  } catch (e) {
    console.log(label, e.code, e.message, e instanceof errors.JOSEError, e.name, e.claim, e.reason);
  }
}

const token = await sign({ role: "admin", exp: iat + 3600 });
console.log(token);
await verify("valid", token, { issuer: "urn:scriptc:issuer", audience: "urn:scriptc:audience" });
await verify("bytes token", encoder.encode(token));
await verify("wrong secret", token, {}, encoder.encode("another-secret"));
const [header, body, signature] = token.split(".");
const forged = Buffer.from(JSON.stringify({ role: "root", sub: "mallory" })).toString("base64url");
await verify("tampered payload", `${header}.${forged}.${signature}`);
await verify("tampered signature", `${header}.${body}.${signature.slice(0, -2)}AA`);
await verify("malformed", "not-a-jwt");
await verify("bad signature encoding", `${header}.${body}.***`);
await verify("expired", token, { currentDate: new Date((iat + 7200) * 1000) });
await verify("clock tolerance", token, { currentDate: new Date((iat + 3610) * 1000), clockTolerance: 30 });
await verify("not yet valid", await sign({ nbf: iat + 600 }));
await verify("issuer", token, { issuer: "urn:other" });
await verify("audience", token, { audience: "urn:other" });
await verify("required claim", token, { requiredClaims: ["jti"] });
await verify("alg not allowed", token, { algorithms: ["HS512"] });
await verify("max token age", token, { maxTokenAge: 600 });

const hs384 = await sign({ scope: "read" }, "HS384");
await verify("hs384", hs384, { algorithms: ["HS384"] });
const hs512 = await sign({ scope: "write" }, "HS512");
await verify("hs512", hs512, { algorithms: ["HS256", "HS512"] });
await verify("hs512 as hs256 only", hs512);
await verify("none", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${body}.`, { algorithms: ["none"] });

// The same key imported once and reused as a CryptoKey.
const cryptoKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
await verify("crypto key", token, {}, cryptoKey);
const signingKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
await verify("wrong key hash", token, {}, signingKey);

// Chained builder calls: jose's declarations type every setter's result as
// `this`, implemented by the JWTClaimsBuilder base SignJWT extends.
const chained = await new SignJWT({ role: "reader" })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuedAt(iat)
  .setIssuer("urn:scriptc:issuer")
  .setAudience(["urn:scriptc:audience", "urn:other"])
  .setSubject("bob")
  .setJti("jti-2")
  .setNotBefore(iat - 60)
  .setExpirationTime(iat + 60)
  .sign(secret);
console.log(chained);
await verify("chained", chained, { audience: "urn:scriptc:audience" });

// String durations: jose's secs() parses them.
for (const maxTokenAge of ["10 minutes", "1 hour", "1.5h", "2 days", "+20m", "1 week", "1y", "900 secs", "3 HOURS", "2h ago", "-2h ago", "10 fortnights", ""]) {
  await verify(`max token age ${JSON.stringify(maxTokenAge)}`, token, { maxTokenAge });
}
for (const clockTolerance of ["30s", "5 sec", "1 min from now", "1 min ago"]) {
  await verify(`clock tolerance ${clockTolerance}`, token, { currentDate: new Date((iat + 3620) * 1000), clockTolerance });
}
const relative = new SignJWT({ role: "reader" });
relative.setProtectedHeader({ alg: "HS256" }).setIssuedAt("-1 minute").setExpirationTime("2h");
const claims = JSON.parse(Buffer.from((await relative.sign(secret)).split(".")[1], "base64url").toString());
const clock = Math.floor(Date.now() / 1000);
console.log(Math.abs(claims.exp - clock - 7200) <= 2, Math.abs(claims.iat - clock + 60) <= 2);
try {
  new SignJWT({}).setExpirationTime("soon");
} catch (e) {
  console.log(e.name, e.message);
}
