// Object.assign over a narrowed record arm is lowered only when every
// source field lands on a field the target's type declares. A source that
// GROWS the target (the coding-agent's `Object.assign(tool, { promptSnippet,
// promptGuidelines })`) adds a key a fixed record cannot hold, so the
// refusal stands by name rather than copying through the wrong layout.
interface Tool {
  name: string;
}
type ToolOrLabel = Tool | { label: string };

function install(candidate: ToolOrLabel): void {
  if ("name" in candidate) {
    Object.assign(candidate, { name: "renamed", promptSnippet: "snippet" });
  }
  console.log(JSON.stringify(candidate));
}

install({ name: "first" });
