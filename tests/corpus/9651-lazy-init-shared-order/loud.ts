import { id } from "./ids.ts";
import { ROWS } from "./table.ts";

// Output at load: this module runs where it is imported, and it draws from
// the counter and reads the table while it does. (The test is always true;
// the compiler does not know.)
export const LOUD: string[] = [];
if (process.argv.length > 0) {
  console.log("loud loads with", ROWS.length, "rows and draws", id("loud"));
  for (const row of ROWS) LOUD.push(row.name.toUpperCase());
}
