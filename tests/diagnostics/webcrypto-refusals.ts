// The native WebCrypto surface is crypto.subtle's secret-key slice and its
// ECDSA, Ed25519 and RSA algorithms, called directly on crypto.subtle.
// crypto.subtle or its methods taken as values are refused by name; the
// bundled declarations omit the other SubtleCrypto methods
// (node-types/fenced.ts pins their fence under @types/node).
const subtle = crypto.subtle;
console.log(typeof subtle);

console.log(typeof crypto.subtle.sign);
