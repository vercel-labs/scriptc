import { ticket } from "./tally.ts";

// Only computes; loaded by import(), before or after second.ts.
export const FIRST: number[] = [];
for (let i = 0; i < 3; i++) FIRST.push(ticket());
