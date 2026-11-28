// A regex literal's template is a static record the runtime compiles into
// and fills in while matching. This literal has no build-time matcher, so the
// runtime reaches its simple-scan cache, whose slot has to exist in the
// emitted template: the sanitized lane reports the write past an undersized
// record, and a plain run frees memory the record does not own.
const re = /ab(c|d)[0-9]{2,3}/g;
const subject = "xxabc12 yyabd345 zzab9";
const matches: string[] = [];
for (;;) {
  const match = re.exec(subject);
  if (match === null) break;
  matches.push(match[0]);
}
console.log("matches", matches.join(","));
console.log("test", /ab(c|d)[0-9]{2,3}/.test("abd45"), /ab(c|d)[0-9]{2,3}/.test("ab9"));
