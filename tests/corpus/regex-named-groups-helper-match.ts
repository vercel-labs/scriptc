// Named capture groups on a match a local helper returns: the helper's one
// returned expression carries `RE.exec(s) ?? undefined`, so the compile-time
// group-name table still reaches the `.groups` read at the call site. Node
// prints the same lines.

const SEPARATED = new RegExp(`(?<word>[a-z]+)-(?<num>[0-9]+)`);

const matchSeparated = (text: string) => {
  if (!text.includes("-")) {
    return;
  }

  return SEPARATED.exec(text) ?? undefined;
};

const match = matchSeparated("abc-42");
if (match !== undefined && match.groups !== undefined) {
  console.log(match[0], match.groups["word"], match.groups["num"]);
}

const none = matchSeparated("abc42");
console.log(none === undefined);
