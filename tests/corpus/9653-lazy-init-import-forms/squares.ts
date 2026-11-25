import { id } from "./ids.ts";

// Only computes. The program imports it statically and with import().
export const SQUARES: number[] = [];
for (let i = 0; i < 40; i++) SQUARES.push(i * i);
export const DRAWN: number = id("squares");
export const BOX: { rows: number[] } = { rows: SQUARES };
export function square(i: number): number {
  return SQUARES[i]!;
}
