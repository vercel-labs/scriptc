// An Error subclass in the shape of a validation library's: the constructor
// resets the prototype to new.target's, as transpiled code does.
export class IssueError extends Error {
  constructor(issues) {
    super();
    this.issues = [];
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "IssueError";
    this.issues = issues;
  }
  get message() {
    return JSON.stringify(this.issues);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
}
export class StrictIssueError extends IssueError {
  get strict() {
    return true;
  }
}
