// process.report is answered by the Node island — one bridge call, no
// native reimplementation of Node's diagnostic report. A build with no
// island (this one has none) keeps the refusal that names the member
// rather than fabricating a report.
console.log(typeof process.report.getReport);
console.log(process.report.directory);
