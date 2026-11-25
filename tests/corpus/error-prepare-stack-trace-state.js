// Error.prepareStackTrace is program state: a program saves it, replaces it
// (typically with void 0) and restores it. The value reads back at every
// point, and a function the program installs is the value it is handed when
// it is read again. Calling the DEFAULT value is the named refusal instead
// (native code has no V8 call-site formatter), so this program installs its
// own before it calls anything.
var previous = Error.prepareStackTrace
console.log(typeof previous)
Error.prepareStackTrace = void 0
console.log(typeof Error.prepareStackTrace)
Error.prepareStackTrace = previous
console.log(typeof Error.prepareStackTrace)
console.log(Error.prepareStackTrace === previous)

Error.prepareStackTrace = function () {
  return "custom"
}
console.log(typeof Error.prepareStackTrace)
console.log(Error.prepareStackTrace())
