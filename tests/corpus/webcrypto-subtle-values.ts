// A SubtleCrypto method read as a value in a typed program: the reference is
// a function with Node's name and length (a call through it is refused; the
// method is called on the SubtleCrypto object), so the shapes are compared.
const { subtle } = globalThis.crypto;
const digest = subtle.digest;
console.log("digest", typeof digest, digest.name, digest.length);
const importKey = subtle.importKey;
console.log("importKey", typeof importKey, importKey.name, importKey.length);
const encrypt = subtle.encrypt;
console.log("encrypt", typeof encrypt, encrypt.name, encrypt.length);
const unwrapKey = subtle.unwrapKey;
console.log("unwrapKey", typeof unwrapKey, unwrapKey.name, unwrapKey.length);
const direct = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
console.log("direct", new Uint8Array(direct).length);
