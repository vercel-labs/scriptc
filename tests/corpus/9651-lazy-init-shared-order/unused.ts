// Imported and never used: nothing reads these.
export const SQUARES: number[] = [];
for (let i = 0; i < 64; i++) SQUARES.push(i * i);
export const LABELS: Map<number, string> = new Map(SQUARES.map((n): [number, string] => [n, "s" + n]));
