'use strict';
// A timer callback that may read `this` is called with its timer handle.
// A checked-dynamic callback keeps the handle form even when the setTimeout
// call is a statement and the callback takes trailing arguments, so the
// callback sees a defined receiver that is not the global object. The
// assigned form still sees the handle the call returned, and an immediate's
// callback sees its immediate.
const seen = [];

function statementTrailing(cb, value) {
  setTimeout(cb, 0, value);
}
function assignedTrailing(cb, value) {
  return setTimeout(cb, 0, value);
}
function immediateTrailing(cb, value) {
  setImmediate(cb, value);
}

function statementReport(value) {
  seen.push(['statement', this !== undefined, this !== globalThis, value]);
}
statementTrailing(statementReport, 'statement-arg');

let assignedHandle;
function assignedReport(value) {
  seen.push(['assigned', this === assignedHandle, value]);
}
assignedHandle = assignedTrailing(assignedReport, 'assigned-arg');

function immediateReport(value) {
  seen.push(['immediate', this !== undefined, this !== globalThis, value]);
}
immediateTrailing(immediateReport, 'immediate-arg');

setTimeout(() => {
  for (const entry of seen.map((line) => line.join(' ')).sort()) console.log(entry);
}, 30);
