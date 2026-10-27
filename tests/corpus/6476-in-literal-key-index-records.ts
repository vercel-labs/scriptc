// `"k" in record` with a literal key over an index-signature record (a
// match's named groups, a dictionary) answers the record's own keys.
function source(header: string): string | undefined {
  const result = /^x-meta-source: (?<id>dpl_.*)/m.exec(header);
  if (result?.groups && "id" in result.groups) {
    return result.groups.id;
  }
  return undefined;
}
console.log(source("x-meta-source: dpl_123\nother: 1"), source("nothing"));
const both = /(?<key>\w+)=(?<value>\w*)/.exec("mode=fast");
if (both?.groups) {
  console.log("key" in both.groups, "value" in both.groups, "other" in both.groups);
}
const dict: Record<string, number> = { a: 1 };
dict["late"] = 2;
delete dict["a"];
console.log("a" in dict, "late" in dict, "missing" in dict, "toString" in dict);
