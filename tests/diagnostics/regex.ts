// The d flag is outside the native slice; .groups needs a
// statically-known regex. Named capture groups (corpus 2604) and regex
// method values (corpus 8912/8913) compile; regex union arms do not.
const indices = /cat/d;
const maybe: RegExp | undefined = /a/;
function readGroups(re: RegExp): void {
  const m = re.exec("2024-07");
  if (m) console.log(m.groups);
}
readGroups(/(?<year>\d{4})/);
