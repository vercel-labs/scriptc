/** A generated class table's index over a class key. A key starts with
 * `object:` and is printable ASCII, so its length and its last four bytes
 * together name it apart from every other key of the table in nearly every
 * case: the folded word below selects the table's switch case, and the keys
 * that still agree (equal length, equal last four bytes) share a case, where
 * the branches' own exact key tests keep them apart. */

/** The odd constant the index multiplies a key's length by: the fractional
 * part of the golden ratio read as a 32-bit word. The emitted code multiplies
 * the capsule's key length by the same word. */
export const CLASS_KEY_LEN_MIX = 0x9e3779b1 | 0;

/** The key's last four ASCII bytes as a little-endian word: the word the
 * emitted code loads from the key's tail. */
export function classKeyTail(key: string): number {
  const start = key.length - 4;
  let word = 0;
  for (let i = 0; i < 4; i++) word |= key.charCodeAt(start + i) << (8 * i);
  return word >>> 0;
}

/** The switch case a class key selects, masked to 31 bits: the key's last
 * four bytes plus its length times CLASS_KEY_LEN_MIX, so keys that share a
 * tail answer different values unless their lengths match too. A key too
 * short to hold four answers -1, which no case holds. */
export function classKeyHash(key: string): number {
  if (key.length < 4) return -1;
  return (Math.imul(key.length, 0x9e3779b1) + classKeyTail(key)) & 0x7fffffff;
}
