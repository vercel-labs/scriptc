// crypto.sign and crypto.verify under RSA_X931_PADDING: the X9.31 encoding
// (0x6A, nonzero filler, 0xBA, then the digest's X9.31 identifier), the
// digests it accepts, the signatures Node produces accepted here and the
// rejections for a tampered signature, an unsupported digest and a key too
// small for the encoding. X9.31 padding is randomized, so only the verify
// results are printed.
import * as crypto from "node:crypto";

const RSA = `-----BEGIN PRIVATE KEY-----
MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAMPxzkep4D3m+Yw0
00I9gTBRwi4HmZ0//s3DzlrlIpYk+GOm6OS8aGAmNJVSf02rIWYeOs/tcedBEdSS
eMkwVNCjtNAkn71BwIwnRw3x4hQESJNerD+mABRvA3sQVmy2BKE27Gt5CwDAMJD5
J2VH/f26iXbhJxAB1ydsI6LKAo53AgMBAAECgYEAig+5mdL/Nn6lfH3IENdHTKV+
3XHrcdoijhcWMgNbIFHCVmzHkkuSe5TP3hq3qiEXMl3AcLtMU3YMuyvNQWz1hKTe
3+cB60htSwAdcmAPRDrKt9vtCWROOKGhn9PLy8xQI0g6sAd/5P1J/XHI5KDHqUbf
B+x45+SMsjfBGGkG3TkCQQDnEOIVnhZpO4h8LH0thE4yxsxS6VkmU1qXJnA/oudA
/zcYuzpvx74RqycDH50u6otoP8KqLFbNHjA6UmpC4ozdAkEA2Ra0y+YRvbYygw7M
dIwj4v+Jdf0BC+dlsYJp71VT0Qn2dwQ2axLtGYjuIlL82Y7dPk/DurP7QNaTqD0M
aK6ZYwJASHiwIE2cA9drQF8Hx93mVOCrNxn/HxknoZ6puBvU4jrpwfT/KA4C3DHN
I5qnxw5DOSg+WvdbJixgvfoZX+8EdQJBANkJ/IQGZyJWsDWbbAnxukdO2C2gX5V5
KZDJJARmOMA7x6/CBG4Uo/vtjLfAZI9WaBfOQ4+8NazjWwjO0EMwnKUCQDHUbBFP
ogWtqOIKz8DTJp/Hoe5k/yewzh6c7831t2BmlXcmHgLJIxN/KaP3LhRHK7CxiHDS
sQ16KD5lGfjh1N4=
-----END PRIVATE KEY-----
`;
// A SHA-256 X9.31 signature Node produced over "hello world" with this key.
const NODE_SIGNATURE =
  "52188e7c2640cfbcf88f5500a72c92cfbf049f80f5695aef507b5c1e8b1a10ed7db48bfe6bd04f2ce4ea4d5f635a94ee55e6efdfbca22cf5a38c62d123d5b87ade4a03819770458d8419f86c219346d37674089fc4302858f07c99fb551e8f940c754c49a4583b80eda1e43a2fd4eacdeb3c2a6f665091309b3d74b66fe86a7c";

const privateKey = crypto.createPrivateKey(RSA);
const publicKey = crypto.createPublicKey(privateKey);
const data = Buffer.from("hello world");
const signOptions = { key: privateKey, padding: crypto.constants.RSA_X931_PADDING };
const verifyOptions = { key: publicKey, padding: crypto.constants.RSA_X931_PADDING };

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

for (const digest of ["sha1", "sha256", "SHA384", "sha512"]) {
  const signature = crypto.sign(digest, data, signOptions);
  const tampered = Buffer.from(signature);
  tampered[0] ^= 0xff;
  console.log(digest, signature.length, crypto.verify(digest, data, verifyOptions, signature));
  console.log(digest, "tampered", crypto.verify(digest, data, verifyOptions, tampered));
  console.log(digest, "other data", crypto.verify(digest, Buffer.from("other"), verifyOptions, signature));
}

// A signature produced by Node's own OpenSSL verifies here, and the digest
// the encoding carries is the one being verified.
attempt("node signature", () =>
  crypto.verify("sha256", data, verifyOptions, Buffer.from(NODE_SIGNATURE, "hex")),
);
attempt("node signature other digest", () =>
  crypto.verify("sha1", data, verifyOptions, Buffer.from(NODE_SIGNATURE, "hex")),
);
attempt("node signature short", () =>
  crypto.verify("sha256", data, verifyOptions, Buffer.from(NODE_SIGNATURE, "hex").subarray(1)),
);

// X9.31 admits SHA-1 and the SHA-2 family only, and the encoding must fit
// the modulus.
attempt("sha224 sign", () => crypto.sign("sha224", data, signOptions).length);
attempt("sha224 verify", () => crypto.verify("sha224", data, verifyOptions, crypto.sign("sha224", data, signOptions)));
attempt("null digest sign", () => crypto.sign(null, data, signOptions).length);
attempt("null digest verify", () =>
  crypto.verify(null, data, verifyOptions, crypto.sign(null, data, signOptions)),
);
attempt("short key", () => {
  const small = crypto.generateKeyPairSync("rsa", { modulusLength: 512 });
  return crypto.sign("sha512", data, { key: small.privateKey, padding: crypto.constants.RSA_X931_PADDING }).length;
});
attempt("pkcs1 signature as x931", () =>
  crypto.verify("sha256", data, verifyOptions, crypto.sign("sha256", data, privateKey)),
);
attempt("x931 signature as pkcs1", () =>
  crypto.verify("sha256", data, publicKey, crypto.sign("sha256", data, signOptions)),
);
