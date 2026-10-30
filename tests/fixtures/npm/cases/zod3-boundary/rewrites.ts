// Rewrites the declaration-typed boundary makes in user code: a typed
// parameter of a bare `async` arrow zod calls, and a cast at the start of
// an unbraced loop body.
import { z } from "zod";

const Box = z.object({ n: z.number() });
const raw: unknown = { n: 2 };

// The cast opens the loop body's statement; the loop runs it each time.
let seen = 0;
for (let i = 0; i < 3; i++) Box.parse(raw).n > 0 && seen++;
let left = 2;
while (left-- > 0) Box.parse(raw).n > 1 && seen++;
console.log("loops", seen);

// zod calls the callback with the string it checked.
const Length = z.string().transform(async s => s.length + 1);
async function main(): Promise<void> {
  console.log("async arrow", await Length.parseAsync("abc"));
}
void main();
