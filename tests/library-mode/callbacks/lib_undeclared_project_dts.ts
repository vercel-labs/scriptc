/// <reference path="./host_undeclared_project.d.ts" />

// The profile declares callbacks, but not `sneaky`. Keeping the declaration
// in a project .d.ts pins the same SC4024 path as an in-source ambient.
export function stream(n: number, base: number): number {
  sneaky(base);
  return n;
}

export function askHost(x: number): number {
  return x;
}

export function pokeOrphan(): number {
  return 0;
}
