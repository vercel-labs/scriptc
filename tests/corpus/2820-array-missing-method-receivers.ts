// Array-derived string and RegExp receivers keep their possible undefined
// value until method lookup. A missing receiver throws before method
// arguments run, with the same TypeError and message as Node.
const strings: string[] = ["  present  "];
console.log(strings[0].trim());
strings[0] = strings[1];
let stringArgEffects = 0;
try {
  strings[0].includes((stringArgEffects++, "x"));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log(stringArgEffects);

const patterns: RegExp[] = [/present/];
console.log(patterns[0].test("present"));
patterns[0] = patterns[1];
let regexArgEffects = 0;
try {
  patterns[0].test((regexArgEffects++, "present"));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log(regexArgEffects);
