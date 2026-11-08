// Throws while it loads, after printing once.
const WORDS: string[] = ["one", "two"];
console.log("broken starts with", WORDS.length, "words");
function word(index: number): string {
  const found = WORDS[index];
  if (found === undefined) throw new RangeError("no word " + index);
  return found;
}
export const MISSING: string = word(5);
