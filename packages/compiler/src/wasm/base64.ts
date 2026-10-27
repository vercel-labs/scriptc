/* Base64 for WebAssembly module bytes: decoding inline modules found in
 * source text (discover.ts) and carrying translated modules on the IR
 * (IrModule.wasmModules). Plain TypeScript, so the native compiler
 * compiles it too. */

const BASE64_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  // base64url spellings
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Decodes standard or URL-safe base64 (padding optional); null when the
 * text is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  if (text.length - end > 2 || end % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? BASE64_VALUES[c]! : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return j === out.length ? out : out.subarray(0, j);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]!;
    chunk += i + 1 < bytes.length ? BASE64_ALPHABET[(n >> 6) & 63]! : "=";
    chunk += i + 2 < bytes.length ? BASE64_ALPHABET[n & 63]! : "=";
    if (chunk.length >= 65536) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}
