// Strict mode code may not assign to `eval` or `arguments`
// (AssignmentTargetType is not simple for those names there), and the
// checker types the reference as an ordinary binding.
"use strict";
async function drain(rows) {
  for (const row of rows) {
    ([arguments] = row);
  }
}
drain([]);
