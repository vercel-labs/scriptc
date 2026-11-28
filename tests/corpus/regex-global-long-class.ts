// A global scan over a long pattern: the simple alternation scan is built
// once per pattern, not once per match, so a class whose source is far
// longer than the subject stays linear in the pattern plus the subject. A
// per-exec rebuild would take pattern length times match count here.
const pattern = "[" + "a".repeat(50000) + "]";
const subject = "a".repeat(200000);
const re = new RegExp(pattern, "g");
let matches = 0;
for (;;) {
  const m = re.exec(subject);
  if (m === null) break;
  matches++;
}
console.log("matches", matches);
