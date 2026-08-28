// Host-callback conformance fixture: profile-declared channels a
// service-shaped export streams through — synchronously, on the calling
// thread. `stream` emits N chunks interleaved with computation (the return
// value depends on work done between emits, so ordering is observable);
// `askHost` round-trips scalars through host RETURNS (i32/u32 inbound);
// `pokeOrphan` calls the one channel the probe deliberately never
// registers (the SC4025 unregistered-call trap path).
declare function emitChunk(chunk: Uint8Array, seq: number): void;
declare function progress(done: number, total: number): number;
declare function note(text: string, last: boolean): void;
declare function mix(a: number, b: number): number;
declare function orphan(x: number): void;

let sessions = 0;

export function stream(n: number, base: number): number {
  sessions++;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const chunk = new Uint8Array(3);
    chunk[0] = 65 + i; // 'A' + i
    chunk[1] = 48 + ((base + i) % 10); // a digit tied to the arguments
    chunk[2] = 33; // '!'
    emitChunk(chunk, i);
    acc += (i + 1) * base; // computation between emits
    note(`chunk ${i} away`, i === n - 1);
  }
  return acc + sessions;
}

export function askHost(x: number): number {
  return progress(x, 10) * 2 + mix(x + 300, 0 - x);
}

export function pokeOrphan(): number {
  orphan(7);
  return -1;
}

console.log("callbacks ready");
