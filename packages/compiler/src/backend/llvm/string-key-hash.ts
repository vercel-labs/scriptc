// Compile-time copy of the runtime's 32-bit string key hash (scr_key_hash in
// packages/runtime/src/scr_key.h, folded by scr_map_hash_fold in scr_map.c).
// On 64-bit little-endian targets the runtime caches this value in the high
// half of a string's capacity word; emitting it for immortal literals lets
// Map/Set lookups with literal keys skip hashing entirely. Both sides pin the
// same vectors in their tests: a mismatch would make literal keys miss.

const MASK64 = (1n << 64n) - 1n;

function mix(input: bigint): bigint {
  let value = input;
  value = value ^ (value >> 30n);
  value = (value * 0xbf58476d1ce4e5b9n) & MASK64;
  value = value ^ (value >> 27n);
  value = (value * 0x94d049bb133111ebn) & MASK64;
  return value ^ (value >> 31n);
}

function u32le(bytes: Uint8Array, offset: number): bigint {
  return BigInt(
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
      0,
  );
}

function shortWord(bytes: Uint8Array, offset: number, length: number): bigint {
  if (length >= 4) return (u32le(bytes, offset) << 32n) | u32le(bytes, offset + length - 4);
  if (length === 0) return 0n;
  return (
    (BigInt(bytes[offset]!) << 16n) |
    (BigInt(bytes[offset + Math.floor(length / 2)]!) << 8n) |
    BigInt(bytes[offset + length - 1]!)
  );
}

/** scr_key_hash over UTF-8 bytes (64-bit, host little-endian loads). */
export function scrKeyHash(bytes: Uint8Array): bigint {
  const length = bytes.length;
  let hash = (0x9e3779b97f4a7c15n * BigInt(length + 1)) & MASK64;
  if (length <= 8) return mix(hash ^ shortWord(bytes, 0, length));
  let i = 0;
  while (length - i >= 8) {
    const word = u32le(bytes, i) | (u32le(bytes, i + 4) << 32n);
    hash = mix(hash ^ word);
    i += 8;
  }
  return mix(hash ^ shortWord(bytes, i, length - i));
}

/** The cached 32-bit Map key hash (never zero; zero means "not computed"). */
export function stringKeyHash32(bytes: Uint8Array): number {
  const hash = scrKeyHash(bytes);
  const folded = Number((hash ^ (hash >> 32n)) & 0xffffffffn);
  return folded === 0 ? 1 : folded;
}

/** The capacity word of an immortal literal on 64-bit targets: cap = len in
 * the low half, the precomputed key hash in the high half, printed as the
 * signed i64 LLVM expects. */
export function literalCapWord(bytes: Uint8Array): string {
  const word = BigInt(bytes.length) | (BigInt(stringKeyHash32(bytes)) << 32n);
  return BigInt.asIntN(64, word).toString();
}
