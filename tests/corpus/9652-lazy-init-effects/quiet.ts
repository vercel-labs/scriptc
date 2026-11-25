// Only computes, and the program exits before anything reads it.
export const POWERS: number[] = [];
for (let i = 0; i < 40; i++) POWERS.push(2 ** i);
export function power(i: number): number {
  return POWERS[i]!;
}
