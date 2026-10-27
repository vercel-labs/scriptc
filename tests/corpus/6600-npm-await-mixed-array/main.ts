// for await over JavaScript array literals mixing promises and plain values
// (in a dependency): every value is awaited before the body runs, a break
// ends the loop, and a rejected element rejects the loop at that step.
import { run } from 'mixed-awaits';

for (const line of await run()) console.log(line);
