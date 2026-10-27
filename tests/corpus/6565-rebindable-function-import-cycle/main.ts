// A package whose import cycle calls a reassigned function declaration
// while the cycle initializes.
import { report } from "cycle-format";

for (const line of report()) console.log(line);
