// The d flag is outside the native slice; .groups needs a
// statically-known regex. Named capture groups compile (corpus 2604).
// Method values and regex union arms remain unsupported; arrays compile.
const indices = /cat/d;
const asValue = /x/.test;
const maybe: RegExp | undefined = /a/;
function readGroups(re: RegExp): void {
  const m = re.exec("2024-07");
  if (m) console.log(m.groups);
}
readGroups(/(?<year>\d{4})/);
