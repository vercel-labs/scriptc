// TypeScript callers of JavaScript toString overrides whose inferred
// results differ from the inherited string.
import { IssueError, LabelError } from "./errors.js";
const issues = new IssueError(["a is required", "b must be a number"]);
console.log(issues.toString());
console.log(String(issues), `${new IssueError([])}`);
const errors: Error[] = [issues, new LabelError("db", "down"), new Error("plain")];
for (const e of errors) console.log(e.toString(), e instanceof IssueError);
console.log(errors.map((e) => String(e)).join(" | "));
