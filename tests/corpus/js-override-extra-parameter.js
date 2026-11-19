// A JavaScript override may declare parameters the inherited method does
// not carry (`toString(compact)` over Error's `toString()`): a call on the
// declaring class passes them to the body, and a call through the base
// type omits them, binding undefined. The result converts into the
// inherited return type, as the slot does.
class Report extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "Report";
    this.detail = detail;
    this.message = reason;
  }
  toString(compact) {
    return `${this.name}: ${this.message}${compact ? "" : ` (${this.detail})`}`;
  }
}

const report = new Report("boom", "extra detail");
console.log(report.toString(true));
console.log(report.toString(false));
console.log(report.toString());
const raised = new Error("plain");
raised.name = report.name;
console.log(String(report).startsWith("Report: boom"));
