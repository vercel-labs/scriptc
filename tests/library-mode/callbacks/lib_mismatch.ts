// CB6 refusal fixture: the ambient declaration's first parameter is
// `string` where the profile's emitChunk channel declares bytes — the
// TypeScript signature and the channel's classes must agree (SC4024).
declare function emitChunk(chunk: string, seq: number): void;

export function stream(n: number, base: number): number {
  emitChunk("hi", base);
  return n;
}

export function askHost(x: number): number {
  return x;
}

export function pokeOrphan(): number {
  return 0;
}
