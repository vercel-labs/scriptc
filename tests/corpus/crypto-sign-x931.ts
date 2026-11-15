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
// A signature over the complement of the encoded block: OpenSSL replaces a
// recovered block whose low nibble is not 0xC with the modulus complement
// before the X9.31 check, so this signature verifies in Node.
const COMPLEMENT_SIGNATURE =
  "71d93fcb839f6e2a00fcdfd29b10ee6092bd8e86a433e50f7d48723c5a0885377aaf1aea78ec1933414a47f31bf3163310374af030cfba4b6e482fa7a55a9c55c56acca3084cfc33080d4ea1d04ecd30d21f560c7b75d7bb7e86e115014e267094c1a021d4b2c53f42ef14ed3573132fcf4d4c71c0bf70a68c2eaeec5a1a23fb";
// A 536-bit key leaves room for the bare 0x6A || digest || hash id || 0xCC
// form of the encoding, and a 520-bit key leaves no room at all.
const SHORT_KEY = `-----BEGIN PRIVATE KEY-----
MIIBYgIBADANBgkqhkiG9w0BAQEFAASCAUwwggFIAgEAAkQA2LqPhb2w4bAg8sxL
kR4mqbpOEQfmHtlNUr+wwFl3aEkuR0hNuJPKpbR3PbNz68W7hALJiLR1KgiHfYwx
asm3zKHK9QIDAQABAkQA1A5Wd8mO1IR8+JQkLC2QLun3kHpmEzETky+0RcBEMWnJ
HVm8QrmjgfvAQcuxocRBq8AoU1tZZEkT8jVFRHzlfN4k0QIiD+FVGAIjEdJRNzEy
d83ECbwBJLo1OrFL5E8ihCPaMwU1ZwIiDaXRqS9GuhGA+qDGW49zkrvaBbamVHqa
dSjX7a5/O1kHQwIiDcXJLlxUHBXDGFITyjHsbuDeQQM6PSAdiPJVJjON/6fpywIi
CvdWhI9MUW6HKNvPBvs5boorIbQl6nOpcMKk3oL8EP/0aQIiDcIt8HU7Ig7bsG70
IS1EMkAUKg1uT7e6fihs2ya1+2KtGw==
-----END PRIVATE KEY-----
`;
const SHORT_SIGNATURE = "0b1753ba96f9e54b0e941516ddf9975394b8b17446ae05c7d43c08886c1a8cae905436ffd836d653e484659fa752679a826f39433ea930ff30bbb0f7d4cfb3cd2f7c7a";
const SMALL_KEY = `-----BEGIN PRIVATE KEY-----
MIIBWQIBADANBgkqhkiG9w0BAQEFAASCAUMwggE/AgEAAkIA2VKcApw4CxZPhv2D
njxespxIBxP1D9fablwz6oA3ST0HGgTSusuxdnnAkaIVvnrdwZKMm8UZ+lYb70W+
rBBQ/7sCAwEAAQJCAI1fUP/dshN8UwXEmz9vlEbqpWx9ThkdWQobzuYIvG5XQrKy
P34b/r1Rg0rVWvak1Y/n4svYxDkYFxVdzLXy78wJAiEPytYo+auTqu9N612DKlFs
vE4WnANbC7CU0l6X49/Ap40CIQ3C401xAFWPJ9ishVpYKeuuUO22C5d4TB29MCgZ
OctuZwIhDYemO6zMBtOn+oXvs/SJljMuY8h+R36YZqhlSpR8mr3xAiECx0Z9bENV
AwJYjPyfsQ1FuHw+gnL0siUsG/aNIgq5OCECIQES9zMjcfGPhmowi49SPFo/HEH3
6f41H9Hghjp8mxH0GA==
-----END PRIVATE KEY-----
`;

// The public operation reads a signature as an integer, so a signature whose
// leading byte is zero verifies with that byte present or dropped.
const SHORT_SIZE_KEY = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAKc4wqeGQEsaw2T0
v6WCMo3A0UK/PB5DgSIPW/r0ZRIBmB4scnzY/rl6hqnkRsmmgD9ik77qRSuzazUd
6KVn8EiLAs4TtShUHIZq9n6Tiecdl9XcREkYasvniGUMddjcPJW+s/OdxeL6XccF
5q12tBk3mNG+lxazWmxXlEPbeSaRAgMBAAECgYAO88BUAmkVThtSl5/bSL0Ed80+
TqMtgZO2W/E5i0jOR142tHq4Nx7vrskDv+mkdkLZaBMV6xSsR6q6YSZAQ/70GJae
GU57gvyzAg0x3sP11QWuDHcd+AemjRy7Sz1UCg9CSuDjj97GX3ofO48eV6/XnJzx
wpnLVfYIhlJIvdWUEQJBANQ8EDpHVaYOC0b8XVxFyppdAMdZ4YXjEc8W5xTZ96O8
t9KqWpEWpmoByOKDnes3zRT7qEhgQNYv7nETVGyZ7o8CQQDJtHNpZIaaIGR6d2y1
AHWW0oz+Up7UKcbRh1E76BmD2EWgaLoLAn3R3eJHzkU+U/ZQ5ZO53A8EEveudn3Y
JCjfAkAxv4qGPqZi8DPQheNUd7+QA3DlSbpFaf6IrnOoPZeAuAHWzbvA+rAzdQuj
nPptYn0eCAdgP7+y9TVNKBzIACUdAkA9L2fzCHNsPXc9TwzCuyjwX141p4pWgXW2
CX4y1e0neWtlhV8qB89y4gPKFGAc0Atf7sQpFP/ZFIfdfEQgVJexAkAeglpHGxQh
qQxWVHXwb8EkaTr+yoayl13l459CPBv5wPRRXd9SW46yxxUSRDGaGffCdy6ceZKw
rklCSYnPDlpI
-----END PRIVATE KEY-----
`;
const SHORT_SIZE_X931 = "00db78dea835a01e623207b405ff58c6628e77abae111047a5a70cb99a6c55e11d1fa65938f13485f30155e6162ddb51e116b172b02b93ff00b3cf94bb68c401da90c03b1648ef83c8217050a8b5ecfd8c3ed93c3c175b536ddce5529fde041c771d69182a85db52a2400afbfb510484d9d9934a227ab975a0817cdae37ef16f";
const PSS_KEY = `-----BEGIN PRIVATE KEY-----
MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAKC5rG5e7Xd3dPTb
sIwNX/2Mi2MRX4B7t01y6K7foNB2YoeHToysu7Hl6YkflJEd0TXCRfBNgax0Kuy/
IsIdcZ1M+eXw9u4GT5tlcMxPY/8+WtXS8/0WJAI/FL7buBuUUwLaZkva9Y8X0/wb
H4jMjVtpCCfvwohCoUGqCSKi6Rt5AgMBAAECgYEAmC72zBLqOqJLhcW2pwXLDCLV
oFpE2T1LVPQmyd5JQNm3dahygdTUbB/MPuA+JiHbhFGNM3nP/OCJ/F0GplKGzfBR
qCWmYSxxr9erEGhBZ1UBaP6Aa3BEpoW++Zzb8GoZ1y48MwYc2z84I/iwby+O7FQX
mZ7M1d8aIWyYtciGY9kCQQDROdV4PDGWFEbdr9viL4h3zeFpN6Cev6r72naT5k/k
foD/owtXPkKDJvWD1vertxCaFN0kR74gn6rpJvxd0VgrAkEAxKgcMNIj81Wsj8Lz
utBAINp4xAcOgEDGvRQmQS3tjniDTm8v1pR/5IWsIhYYx+70XjXtbR7nsA/C//ow
5FWE6wJBALKpOyNn60Pn3rfRQud7hYIgWXq6mLrWmtBjtdwH0HMin08sUDPYo31R
GFfTijykn1WjuU8QwEclcRGVS+1lJW8CQFao/kNFVzJT/scbUexw+NGBdNZthaZe
5TVNO85dPuIZmUNnG92jcvhxL3mV4zW3x1f8y7Paep7LU1MaHZGBXiECQGgbRS6h
LPzij48EQTFAYJJl/ZUxlIierApCU++H4MMHbNB2HXDTDAOeyeUsJqNgtH3Di3zv
Y+W/PwMRzt2A4mo=
-----END PRIVATE KEY-----
`;
const PSS_SIGNATURE = "0088125e140db0a3d36b4234e045b03acd69eaeb8fb47b87267ed805145a7314e866cb21f802ba8c84f6c55b3a27c0cad52ba4e4a4630ab144d11c87b255b65d6c1049ca3e3b29f362fd25027b6164ffae6072653ff4aedc76fdd4860d05238b4c72ce9dc5333557979d50bd316362408804acf67f404d1c9373d7d6eb58f2eb";

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

// The modulus complement and the bare 0x6A form are both valid X9.31
// blocks, and a key that cannot hold the block reports Node's size errors.
attempt("complement signature", () =>
  crypto.verify("sha256", data, verifyOptions, Buffer.from(COMPLEMENT_SIGNATURE, "hex")),
);
const shortPrivate = crypto.createPrivateKey(SHORT_KEY);
const shortPublic = crypto.createPublicKey(shortPrivate);
const shortSign = { key: shortPrivate, padding: crypto.constants.RSA_X931_PADDING };
const shortVerify = { key: shortPublic, padding: crypto.constants.RSA_X931_PADDING };
attempt("short block verify", () =>
  crypto.verify("sha512", data, shortVerify, Buffer.from(SHORT_SIGNATURE, "hex")),
);
attempt("short block sign", () => {
  const signature = crypto.sign("sha512", data, shortSign);
  return `${signature.length} ${crypto.verify("sha512", data, shortVerify, signature)}`;
});
attempt("too large for key", () =>
  crypto.sign("sha512", data, {
    key: crypto.createPrivateKey(SMALL_KEY),
    padding: crypto.constants.RSA_X931_PADDING,
  }).length,
);

// A signature value below the modulus can arrive without its leading zero
// byte; both PSS and X9.31 read the signature as an integer, so both forms
// verify.
const shortSizePublic = crypto.createPublicKey(crypto.createPrivateKey(SHORT_SIZE_KEY));
const shortSizeX931 = Buffer.from(SHORT_SIZE_X931, "hex");
attempt("dropped zero x931", () =>
  crypto.verify("sha256", data, { key: shortSizePublic, padding: crypto.constants.RSA_X931_PADDING }, shortSizeX931),
);
attempt("dropped zero x931 short", () =>
  crypto.verify(
    "sha256",
    data,
    { key: shortSizePublic, padding: crypto.constants.RSA_X931_PADDING },
    shortSizeX931.subarray(1),
  ),
);
const pssPublic = crypto.createPublicKey(crypto.createPrivateKey(PSS_KEY));
const pssOptions = { key: pssPublic, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
const pssSignature = Buffer.from(PSS_SIGNATURE, "hex");
attempt("dropped zero pss", () => crypto.verify("sha256", data, pssOptions, pssSignature));
attempt("dropped zero pss short", () => crypto.verify("sha256", data, pssOptions, pssSignature.subarray(1)));
