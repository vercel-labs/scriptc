// Object.assign over a narrowed record arm whose source grows the target
// (the coding-agent's `Object.assign(tool, { promptSnippet })` after a
// discriminant check): the declared keys write in place and the added one
// joins the record's kept source, so the value keeps growing the way Node's
// one object does.
interface Tool {
  name: string;
}
type ToolOrLabel = Tool | { label: string };

function install(candidate: ToolOrLabel): void {
  if ("name" in candidate) {
    Object.assign(candidate, { name: "renamed", promptSnippet: "snippet" });
    console.log(JSON.stringify(candidate));
    console.log(Object.keys(candidate).join(","), "promptSnippet" in candidate);
    return;
  }
  console.log(JSON.stringify(candidate));
}

install({ name: "first" });
install({ label: "tag" });
