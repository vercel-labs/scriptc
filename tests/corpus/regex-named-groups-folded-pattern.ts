// Named capture groups behind a pattern the compiler folds at compile time:
// `new RegExp` over a template of const strings. The group-name table is
// built from the folded pattern, so `.groups` lowers even though the
// expression is not a regex literal. Node prints the same lines.

const PREFIX = "(?<word>[a-z]+)";
const SUFFIX = "-(?<num>[0-9]+)";
const re = new RegExp(`${PREFIX}${SUFFIX}`, "u");

const match = re.exec("abc-42");
if (match !== null && match.groups !== undefined) {
  console.log(match[0], match.groups["word"], match.groups["num"]);
}

const joined = new RegExp(PREFIX + ":" + "(?<rest>.*)");
const other = joined.exec("abc:rest of it");
if (other !== null && other.groups !== undefined) {
  console.log(other.groups["word"], other.groups["rest"]);
}

console.log(re.test("abc-42"), re.source);
