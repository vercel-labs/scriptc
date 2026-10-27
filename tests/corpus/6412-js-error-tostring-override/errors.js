// JavaScript Error subclasses whose toString overrides infer results that
// differ from Error.prototype.toString's string.
export class IssueError extends Error {
  constructor(issues) {
    super("invalid");
    this.issues = issues;
    this.name = "IssueError";
  }
  /** @returns {string | undefined} */
  toString() {
    return this.issues.length > 0 ? this.issues.join("; ") : undefined;
  }
}
export class LabelError extends Error {
  constructor(label, detail) {
    super(detail);
    this.label = label;
  }
  toString() {
    return this.label;
  }
}
