// Method chains over `any`-derived strings: each step that answers a fresh
// native value (split's string[]) keeps chaining through the
// checked-dynamic value — map, filter(Boolean), pop, join — and the result
// checks back into typed slots.
function exec(): any {
  return { stdout: " 3f2a\n  9c1b \n\n77de\n", stderr: "warn: shallow\n" };
}

const { stdout, stderr } = exec();
let ids: string[] = [];
ids = stdout
  .split("\n")
  .map((s: string) => s.trim())
  .filter(Boolean);
console.log(ids.length, ids.join(", "));

const last: string = stdout.trim().split("\n").pop() ?? "";
console.log(JSON.stringify(last));

const firstWord: string = stderr.trim().split(":")[0];
console.log(firstWord, stderr.trim().split(" ").length);

const words: string[] = stdout.trim().split(/\s+/);
console.log(words.length, stdout.split("\n").length, stdout.trim().split("\n").join("|"));
