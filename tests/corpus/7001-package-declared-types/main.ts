// A package that compiles from its JavaScript, whose interfaces, type
// aliases and enums exist only in its .d.ts. A program that imports its
// values compiles the JavaScript, and the type-only names it imports keep
// the declarations TypeScript reads from the .d.ts.
import { Severity, collect, firstOf, label, type Issue, type Page, type Report } from "issue-list";

function report(text: string): Report {
  const issues: Issue[] = [];
  const count = collect(text, issues);
  return { count, issues };
}

const result = report("a?b!c?");
console.log(result.count, result.issues.length);
const first = result.issues[0]!;
console.log(label(first.severity), first.offset, first.severity === Severity.Warning);
const page: Page<Issue> = { items: result.issues.slice(1), next: null };
console.log(page.items.map((issue) => `${label(issue.severity)}@${issue.offset}`).join(","), page.next);
console.log(firstOf(page)?.offset);
