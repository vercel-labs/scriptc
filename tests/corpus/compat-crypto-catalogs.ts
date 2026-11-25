// The catalog functions of node:crypto: the hash, cipher and curve names
// the build offers, and the constants object.
import { constants, getCiphers, getCurves, getHashes } from "node:crypto";

const hashes = getHashes();
const ciphers = getCiphers();
const curves = getCurves();
console.log(Array.isArray(hashes), hashes.includes("sha256"), hashes.includes("sha512"), hashes.includes("nope"));
console.log(Array.isArray(ciphers), ciphers.includes("aes-256-gcm"), ciphers.includes("aes-128-cbc"));
console.log(Array.isArray(curves), curves.includes("prime256v1"), curves.includes("secp256k1"));
console.log(typeof constants.RSA_PKCS1_PADDING, constants.RSA_PKCS1_PADDING, constants.RSA_PKCS1_OAEP_PADDING);
