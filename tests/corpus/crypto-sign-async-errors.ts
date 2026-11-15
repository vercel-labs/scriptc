// crypto.sign and crypto.verify with a callback: a job that fails reports
// through the callback as a plain Error without the OpenSSL properties,
// after the synchronous code that queued it; a successful job reports a
// null error and its result. The signing is RSA PKCS#1 v1.5, whose bytes
// are deterministic.
import * as crypto from "node:crypto";

const RSA = `-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQDWei4BREJm+4C6u/+F4NI7kTOQ9gf/a+Ecd2SZxfpXRtXT0QVN
MAI1uQNmB4abYzvd1G2V2XKsTJFJcJWibjAz56UxtxxggTpSAalFZYoPm6HfabwJ
b/YWh0K0OrNFvdkeXLLMiHQsxmIQ2lrFoycQEpZ4/yxjLe6LQF+L79k2ywIDAQAB
AoGAMWS/9ZC3zim7ssWbCkUFhaxh+M+AdgVtOXYRmAxtI+5vTjHEC8uzppWuP7Aa
Au0um17RwgHrE90qVIR2IYtI1C9K9RLUNlKKVPqnSSmr0qkXR246R/Zd8eho1XSS
MX6KmnbmRijUx9Rw1AbD2ZmYCrXsPf2HsCdH+SGQ1ZTunnECQQD090dTA21Jyu/b
ADglqgixJCPIoc6qpxst+W1LreIo4UvkSmgnRYvsKDlM7FNI+6f7igI625KXIAnl
xVlmGLXDAkEA4CNVeP07fmQUBs1aPQ9LCOvN42SV6S8Fjbf4XHIYG5Kp48/98oJj
1pFsXNa8nn8fmN9zFw8yM/yd22iZdueCWQJAWMja//po/OrhniVpNDV5awKnOYtz
xSRF1JbnhxthseFeSUKylzE8sn4trnSlBvm2+5MclcqJSd7h13Z8nWVtUwJAZ0SA
Ve0+ov4TKAsnH2jTZnnWc4VdeIFcqq3vdRBwQQvy0G59D2W6ABsidSfO4auqcDHL
gf1TYRZr2LI5usnxiQJAGt3e0QC0q0WN4p49YhyXXVuHccx79RFgfN7V1lkAyYuL
2bPV41mEtD/AbSrObtqqvOaWZjwSr8JCyPdPZZAIMw==
-----END RSA PRIVATE KEY-----
`;

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "returned");
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { library?: string; reason?: string; opensslErrorStack?: string[] };
    console.log(
      label,
      "throws",
      err.name,
      err.code,
      err.message,
      err.library,
      err.reason,
      err.opensslErrorStack === undefined ? "none" : err.opensslErrorStack.join("<"),
    );
  }
}

const rsa = crypto.createPrivateKey(RSA);
const rsaPublic = crypto.createPublicKey(rsa);
const data = Buffer.from("signed data");
const expected = crypto.sign("sha256", data, rsa).toString("hex");
const events: string[] = [];

// The callback runs after the synchronous code that scheduled the job.
// Jobs finish in thread-pool order, so each step queues the next from its
// callback rather than depending on the order of concurrent completions.
const x25519 = crypto.generateKeyPairSync("x25519").privateKey;
const ed25519 = crypto.generateKeyPairSync("ed25519").privateKey;
crypto.sign("sha256", data, rsa, (err, signature) => {
  console.log("sign", err, signature.toString("hex") === expected, events.join(","));
  crypto.verify("sha256", data, rsaPublic, crypto.sign("sha256", data, rsa), (err, ok) => {
    console.log("verify true", err, ok);
    crypto.verify("sha256", data, rsaPublic, Buffer.alloc(256), (err, ok) => {
      console.log("verify false", err, ok);
      // A job that fails passes the error, which carries no code property.
      crypto.sign("sha256", data, x25519, (err) => {
        const e = err as NodeJS.ErrnoException;
        console.log(
          "x25519",
          e.name,
          e.message,
          e.code,
          Object.getOwnPropertyNames(e).filter((n) => n !== "stack").join(),
        );
        crypto.sign("sha256", data, ed25519, (err) => {
          const e = err as NodeJS.ErrnoException;
          console.log("ed25519 digest", e.name, e.message, e.code);
        });
      });
    });
  });
});
events.push("after sign");

// Argument errors throw before any callback runs.
attempt("bad key", () => crypto.sign("sha256", data, "not a key", () => {}));
attempt("bad padding", () => crypto.sign("sha256", data, { key: rsa, padding: 1.5 }, () => {}));
attempt("missing callback is synchronous", () => crypto.sign("sha256", data, rsa).length);
attempt("verify bad key", () => crypto.verify("sha256", data, "not a key", Buffer.alloc(8), () => {}));

console.log("sync done");
