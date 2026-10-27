// WebCrypto ECDSA, RSASSA-PKCS1-v1_5 and RSA-PSS: importKey from spki,
// pkcs8, jwk and raw, exportKey to each format, sign and verify (RSA
// PKCS#1 v1.5 signatures are deterministic, so they compare with Node),
// generateKey for every curve and both RSA algorithms, and the CryptoKey
// members of these keys.
const RSA_PKCS8 = "MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBANZ6LgFEQmb7gLq7/4Xg0juRM5D2B/9r4Rx3ZJnF+ldG1dPRBU0wAjW5A2YHhptjO93UbZXZcqxMkUlwlaJuMDPnpTG3HGCBOlIBqUVlig+bod9pvAlv9haHQrQ6s0W92R5cssyIdCzGYhDaWsWjJxASlnj/LGMt7otAX4vv2TbLAgMBAAECgYAxZL/1kLfOKbuyxZsKRQWFrGH4z4B2BW05dhGYDG0j7m9OMcQLy7Omla4/sBoC7S6bXtHCAesT3SpUhHYhi0jUL0r1EtQ2UopU+qdJKavSqRdHbjpH9l3x6GjVdJIxfoqaduZGKNTH1HDUBsPZmZgKtew9/YewJ0f5IZDVlO6ecQJBAPT3R1MDbUnK79sAOCWqCLEkI8ihzqqnGy35bUut4ijhS+RKaCdFi+woOUzsU0j7p/uKAjrbkpcgCeXFWWYYtcMCQQDgI1V4/Tt+ZBQGzVo9D0sI683jZJXpLwWNt/hcchgbkqnjz/3ygmPWkWxc1ryefx+Y33MXDzIz/J3baJl254JZAkBYyNr/+mj86uGeJWk0NXlrAqc5i3PFJEXUlueHG2Gx4V5JQrKXMTyyfi2udKUG+bb7kxyVyolJ3uHXdnydZW1TAkBnRIBV7T6i/hMoCycfaNNmedZzhV14gVyqre91EHBBC/LQbn0PZboAGyJ1J87hq6pwMcuB/VNhFmvYsjm6yfGJAkAa3d7RALSrRY3inj1iHJddW4dxzHv1EWB83tXWWQDJi4vZs9XjWYS0P8BtKs5u2qq85pZmPBKvwkLI909lkAgz";
const RSA_SPKI = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDWei4BREJm+4C6u/+F4NI7kTOQ9gf/a+Ecd2SZxfpXRtXT0QVNMAI1uQNmB4abYzvd1G2V2XKsTJFJcJWibjAz56UxtxxggTpSAalFZYoPm6HfabwJb/YWh0K0OrNFvdkeXLLMiHQsxmIQ2lrFoycQEpZ4/yxjLe6LQF+L79k2ywIDAQAB";
const EC_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgulVxc4RlBekf+rd5zcCwuDjHgGV3q5kuoMLno5gpArihRANCAATSDCLRr/iS5XGOw7e/Dv2tPdBLGc9juyihWUj4Q2rfkPuZ5Zm/92kVMYW17sF3yUXFpnXR0yjS2X74A623u6Y+";
const EC_SPKI = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE0gwi0a/4kuVxjsO3vw79rT3QSxnPY7sooVlI+ENq35D7meWZv/dpFTGFte7Bd8lFxaZ10dMo0tl++AOtt7umPg==";

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const hex = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString("hex");
const data = new TextEncoder().encode("webcrypto message");

const rsaPrivate = await crypto.subtle.importKey("pkcs8", bytes(RSA_PKCS8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
const rsaPublic = await crypto.subtle.importKey("spki", bytes(RSA_SPKI), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
console.log(rsaPrivate.type, rsaPublic.type, rsaPrivate.extractable, rsaPublic.usages);
const rsaAlgorithm = rsaPrivate.algorithm as RsaHashedKeyAlgorithm;
console.log(rsaAlgorithm.name, rsaAlgorithm.modulusLength, Array.from(rsaAlgorithm.publicExponent), rsaAlgorithm.hash.name);
const rsaSignature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaPrivate, data);
console.log("rsa signature", hex(rsaSignature));
console.log("rsa verify", await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, rsaPublic, rsaSignature, data));
console.log("rsa spki", Buffer.from(await crypto.subtle.exportKey("spki", rsaPublic)).toString("base64") === RSA_SPKI);
console.log("rsa pkcs8", Buffer.from(await crypto.subtle.exportKey("pkcs8", rsaPrivate)).toString("base64") === RSA_PKCS8);
const rsaJwk = await crypto.subtle.exportKey("jwk", rsaPublic);
console.log("rsa jwk", JSON.stringify(rsaJwk));
const fromJwk = await crypto.subtle.importKey("jwk", rsaJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
console.log("rsa jwk verify", await crypto.subtle.verify("RSASSA-PKCS1-v1_5", fromJwk, rsaSignature, data), fromJwk.extractable);

const ecPrivate = await crypto.subtle.importKey("pkcs8", bytes(EC_PKCS8), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const ecPublic = await crypto.subtle.importKey("spki", bytes(EC_SPKI), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
console.log(JSON.stringify(ecPrivate.algorithm), ecPrivate.usages, ecPublic.usages);
console.log("ec jwk", JSON.stringify(await crypto.subtle.exportKey("jwk", ecPrivate)));
const point = await crypto.subtle.exportKey("raw", ecPublic);
console.log("ec raw", hex(point));
const fromPoint = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash }, ecPrivate, data);
  console.log("ecdsa", hash, signature.byteLength, await crypto.subtle.verify({ name: "ECDSA", hash: { name: hash } }, fromPoint, signature, data));
}
const ecSignature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecPrivate, data);
const tampered = new Uint8Array(ecSignature);
tampered[5] ^= 1;
console.log("tampered", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPublic, tampered, data));
console.log("other data", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPublic, ecSignature, new Uint8Array([1])));

for (const namedCurve of ["P-256", "P-384", "P-521"]) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, pair.privateKey, data);
  console.log(namedCurve, Object.keys(pair).join(), pair.privateKey.extractable, pair.publicKey.extractable, signature.byteLength,
    await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, pair.publicKey, signature, data),
    (await crypto.subtle.exportKey("raw", pair.publicKey)).byteLength);
}
for (const name of ["RSASSA-PKCS1-v1_5", "RSA-PSS"]) {
  const pair = await crypto.subtle.generateKey({ name, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-512" }, true, ["sign", "verify"]);
  const params = { name, saltLength: 20 };
  const signature = await crypto.subtle.sign(params, pair.privateKey, data);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  console.log(name, signature.byteLength, await crypto.subtle.verify(params, pair.publicKey, signature, data), jwk.alg, Object.keys(jwk).join());
}
const pss = await crypto.subtle.importKey("pkcs8", bytes(RSA_PKCS8), { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
const pssPublic = await crypto.subtle.importKey("spki", bytes(RSA_SPKI), { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
const pssSignature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pss, data);
console.log("pss", await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, pssPublic, pssSignature, data),
  await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 0 }, pssPublic, pssSignature, data));
console.log(ecPrivate instanceof CryptoKey, String(ecPublic), Object.prototype.toString.call(rsaPublic));
