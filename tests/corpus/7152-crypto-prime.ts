// checkPrimeSync, checkPrime, generatePrimeSync and generatePrime: known
// primes, composites and strong pseudoprimes as bigints, Buffers, typed
// arrays, ArrayBuffers and DataViews, the checks option, and generated
// primes' length, top bits, primality, residues and safety, as
// ArrayBuffers and bigints, synchronously and through the callbacks (whose
// error parameter, typed Error | null, receives null where Node passes
// undefined). The small sizes and the add and rem forms have one possible
// result.
import { checkPrime, checkPrimeSync, generatePrime, generatePrimeSync } from "node:crypto";

const mersenne61 = 2n ** 61n - 1n;
const mersenne127 = 2n ** 127n - 1n;
const mersenne521 = 2n ** 521n - 1n;
const known: [string, bigint][] = [
  ["0", 0n],
  ["1", 1n],
  ["2", 2n],
  ["3", 3n],
  ["4", 4n],
  ["9", 9n],
  ["17863", 17863n],
  ["17881", 17881n],
  ["561 (Carmichael)", 561n],
  ["2047 (strong pseudoprime to 2)", 2047n],
  ["3215031751 (strong pseudoprime to 2, 3, 5 and 7)", 3215031751n],
  ["2^61 - 1", mersenne61],
  ["2^61 + 1", mersenne61 + 2n],
  ["2^127 - 1", mersenne127],
  ["(2^61 - 1)(2^127 - 1)", mersenne61 * mersenne127],
  ["2^521 - 1", mersenne521],
  ["2^521 + 1", mersenne521 + 2n],
];
for (const [label, value] of known) console.log(label, checkPrimeSync(value));

console.log("Buffer 13", checkPrimeSync(Buffer.from([0, 0, 13])));
console.log("Uint8Array 15", checkPrimeSync(new Uint8Array([15])));
const words = new ArrayBuffer(8);
new DataView(words).setBigUint64(0, mersenne61);
console.log("ArrayBuffer 2^61 - 1", checkPrimeSync(words));
console.log("DataView 2^61 - 1", checkPrimeSync(new DataView(words)));
console.log("empty", checkPrimeSync(new Uint8Array(0)));
console.log("checks 1", checkPrimeSync(97n, { checks: 1 }));
console.log("checks 200", checkPrimeSync(3215031751n, { checks: 200 }));

const bitLength = (n: bigint): number => n.toString(2).length;
const fromBuffer = (buffer: ArrayBuffer): bigint => BigInt("0x" + Buffer.from(buffer).toString("hex"));

for (const bits of [2, 3, 4]) console.log("size", bits, generatePrimeSync(bits, { bigint: true }));
const five = generatePrimeSync(5, { bigint: true });
console.log("size 5", five === 29n || five === 31n);
for (const bits of [8, 16, 31, 32, 33, 64, 127, 256, 512]) {
  const p = generatePrimeSync(bits, { bigint: true });
  console.log("size", bits, bitLength(p) === bits, p >> BigInt(bits - 2), checkPrimeSync(p));
}
const buffer = generatePrimeSync(96);
console.log("ArrayBuffer", buffer instanceof ArrayBuffer, buffer.byteLength, checkPrimeSync(buffer), bitLength(fromBuffer(buffer)));
console.log("bigint false", generatePrimeSync(40, { bigint: false }).byteLength);

for (const bits of [3, 6, 7]) console.log("safe", bits, generatePrimeSync(bits, { safe: true, bigint: true }));
for (const bits of [16, 64, 128]) {
  const p = generatePrimeSync(bits, { safe: true, bigint: true });
  console.log("safe", bits, bitLength(p) === bits, p >> BigInt(bits - 2), checkPrimeSync(p), checkPrimeSync((p - 1n) / 2n));
}

console.log("add 200 rem 1", generatePrimeSync(8, { add: 200n, rem: 1n, bigint: true }));
console.log("add 128", generatePrimeSync(8, { add: 128n, bigint: true }));
console.log("add 16 rem 3", generatePrimeSync(5, { add: 16n, rem: 3n, bigint: true }));
const safe4 = generatePrimeSync(5, { add: 4n, safe: true, bigint: true });
console.log("add 4 safe", safe4 === 23n || safe4 === 47n);
for (const [label, add, rem] of [
  ["add 12 rem 11", 12n, 11n],
  ["add 6", 6n, undefined],
  ["add 1000 rem 7", 1000n, 7n],
] as const) {
  const p = generatePrimeSync(48, rem === undefined ? { add, bigint: true } : { add, rem, bigint: true });
  console.log(label, p % add, checkPrimeSync(p), bitLength(p) >= 48);
}
const viaBuffer = generatePrimeSync(64, { add: Buffer.from([0x01, 0x00]), rem: new Uint8Array([0x0f]), bigint: true });
console.log("add and rem as bytes", viaBuffer % 256n, checkPrimeSync(viaBuffer));
const safeAdd = generatePrimeSync(64, { add: 24n, rem: 23n, safe: true, bigint: true });
console.log("safe add 24 rem 23", safeAdd % 24n, checkPrimeSync((safeAdd - 1n) / 2n));
console.log("rem without add", generatePrimeSync(16, { rem: 5n, bigint: true }) < 65536n);

generatePrime(64, (err, prime) => {
  console.log("callback", err ?? "no error", prime instanceof ArrayBuffer, prime.byteLength, checkPrimeSync(prime));
  generatePrime(128, { safe: true, bigint: true }, (err2, safe) => {
    console.log("callback safe", err2 ?? "no error", bitLength(safe), checkPrimeSync((safe - 1n) / 2n));
    checkPrime(safe, (err3, result) => {
      console.log("checkPrime", err3 ?? "no error", result);
      checkPrime(Buffer.from([1, 1]), { checks: 3 }, (err4, result2) => {
        console.log("checkPrime 257", err4 ?? "no error", result2);
      });
    });
  });
});
console.log("sync done");
