// CB6 refusal fixture: the configured channel name resolves to a
// program-authored ambient function VALUE, not the supported signature-only
// function-declaration form. The call must refuse SC4024; it must never be
// mistaken for unused capacity and silently erased.
declare const orphan: (x: number) => void;

export function stream(n: number, base: number): number {
  return n + base;
}

export function askHost(x: number): number {
  return x;
}

export function pokeOrphan(): number {
  orphan(7);
  return 0;
}
