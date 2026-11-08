import { ticket } from "./tally.ts";

// Only computes; loaded by import(), before or after first.ts.
export const SECOND: number[] = [];
for (let i = 0; i < 2; i++) SECOND.push(ticket());
