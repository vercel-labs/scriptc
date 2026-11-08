// Number tables filled by loops at load.
export const SQUARES: number[] = [];
for (let i = 0; i < 20000; i++) SQUARES.push(i * i);
export const BY_ROOT: Map<number, number> = new Map();
for (let i = 0; i < 4000; i++) BY_ROOT.set(SQUARES[i]!, i);
export function root(square: number): number {
  return BY_ROOT.get(square) ?? -1;
}
