// CB6 capacity fixture: the profile declares five channels; this program
// references none of them. A declared-but-unreferenced channel is legal
// capacity — the build succeeds and the registration symbol still answers
// for every declared name.
export function stream(n: number, base: number): number {
  return n * base * 2;
}

export function askHost(x: number): number {
  return x + 1;
}

export function pokeOrphan(): number {
  return 0;
}

console.log("unused ready");
