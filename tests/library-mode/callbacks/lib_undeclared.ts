// CB6 refusal fixture: `sneaky` is a program-authored signature-only
// ambient function the profile's channels do not declare — with a declared
// callback surface, calling it refuses SC4024 (the author reached for the
// host seam the profile does not provide). With the callbacks section
// stripped, the same source keeps Node's ambient ReferenceError semantics
// (the standing guarantee's behavioral half).
declare function emitChunk(chunk: Uint8Array, seq: number): void;
declare function sneaky(x: number): void;

export function stream(n: number, base: number): number {
  emitChunk(new Uint8Array(1), n);
  sneaky(base);
  return n;
}

export function askHost(x: number): number {
  return x;
}

export function pokeOrphan(): number {
  return 0;
}
