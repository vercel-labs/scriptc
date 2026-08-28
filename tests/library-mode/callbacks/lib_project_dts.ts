/// <reference path="./host_project.d.ts" />

// The callback binding intentionally lives in the referenced project .d.ts.
// The remaining profile channels are unused capacity for this fixture.
export function stream(n: number, base: number): number {
  const chunk = new Uint8Array(2);
  chunk[0] = 65 + n;
  chunk[1] = 48 + base;
  emitChunk(chunk, n);
  return n + base;
}

export function askHost(x: number): number {
  return x;
}

export function pokeOrphan(): number {
  return 0;
}
