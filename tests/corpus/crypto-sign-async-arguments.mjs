// The argument checks of crypto.sign and crypto.verify's callback forms:
// they throw synchronously, before any job is queued, and a literal
// undefined callback (or a null one, which Node refuses) selects or rejects
// the callback form rather than the synchronous one. verify's job error for
// an X25519 key reaches its callback without a code property.
import crypto from "node:crypto";

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

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, "=>", result === undefined ? "undefined" : Buffer.isBuffer(result) ? `buffer ${result.length}` : result);
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const data = Buffer.from("async arguments");
const signature = crypto.sign("sha256", data, priv);

// The callback itself, before anything else is read.
attempt("sign callback null", () => crypto.sign("sha256", data, priv, null));
attempt("sign callback string", () => crypto.sign("sha256", data, priv, "x"));
attempt("sign callback number", () => crypto.sign("sha256", data, priv, 5));
attempt("sign callback undefined", () => crypto.sign("sha256", data, priv, undefined).length);
attempt("verify callback undefined", () => String(crypto.verify("sha256", data, pub, signature, undefined)));

// data and signature are read before the key. The key's options object is
// read for `key` first, so an empty object names "key.key".
attempt("sign data number", () => crypto.sign("sha256", 5, priv, () => {}));
attempt("sign data null", () => crypto.sign("sha256", null, priv, () => {}));
attempt("sign data undefined", () => crypto.sign("sha256", undefined, priv, () => {}));
attempt("sign algorithm number", () => crypto.sign(5, data, priv, () => {}));
attempt("sign empty key options", () => crypto.sign("sha256", data, {}, () => {}));
attempt("verify signature number", () => crypto.verify("sha256", data, pub, 5, () => {}));
attempt("verify signature null", () => crypto.verify("sha256", data, pub, null, () => {}));
attempt("verify signature undefined", () => crypto.verify("sha256", data, pub, undefined, () => {}));
attempt("verify data number", () => crypto.verify("sha256", 5, pub, signature, () => {}));
attempt("verify algorithm number", () => crypto.verify(5, data, pub, signature, () => {}));
attempt("verify key number", () => crypto.verify("sha256", data, 5, signature, () => {}));

const x25519 = crypto.generateKeyPairSync("x25519").publicKey;
crypto.verify("sha256", data, x25519, Buffer.alloc(8), (err) => {
  console.log("verify x25519", err.name, err.message, err.code);
});
