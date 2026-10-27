// A binding annotated with a type the checker reads as `any`, initialized
// with an empty object literal, is a dictionary the code fills by key.
class Ref {
  digest: string;
  constructor(digest: string) {
    this.digest = digest;
  }
}
class Blob {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}
function collect(entries: { name: string; sha?: string }[]): unknown {
  const files: any = {};
  for (const entry of entries) {
    files[entry.name] = entry.sha ? new Ref(`sha:${entry.sha}`) : new Blob("");
  }
  files["count"] = entries.length;
  return files;
}
const out = collect([{ name: "a.txt", sha: "abc" }, { name: "dir" }]) as Record<string, unknown>;
console.log(Object.keys(out), out["a.txt"] instanceof Ref, out["dir"] instanceof Blob, out["count"]);
