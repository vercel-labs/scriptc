// Constructors that reset the instance prototype, the transpiled idiom for
// Error subclasses.
import { IssueError, StrictIssueError } from "./issues.js";
class AppError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "AppError";
  }
  describe(): string {
    return `${this.name}: ${this.message}`;
  }
}
class NotFound extends AppError {
  constructor(what: string) {
    super(`${what} not found`);
    Object.setPrototypeOf(this, NotFound.prototype);
    this.name = "NotFound";
  }
}
const app = new AppError("boom");
const missing = new NotFound("user");
console.log(app.describe(), app instanceof AppError, app instanceof Error);
console.log(missing.describe(), missing instanceof NotFound, missing instanceof AppError);
const issues = new IssueError([{ path: "a" }]);
console.log(issues.message, issues.isEmpty, issues instanceof IssueError, issues.name);
const strict = new StrictIssueError([]);
console.log(strict.isEmpty, strict.strict, strict instanceof IssueError, String(strict instanceof StrictIssueError));
try {
  throw new NotFound("page");
} catch (e) {
  console.log(e instanceof NotFound ? e.describe() : "other");
}
