// Error.prepareStackTrace without a formatter of the program's own. Saving
// and restoring the hook around code that installs nothing, and assigning
// undefined, leave an error's stack its text, under Node and in a compiled
// program. (What the hook holds before a program touches it is not printed:
// Node 24 answers its default formatter there, a compiled program
// undefined.)

// Save and restore around code that installs nothing.
function withSavedHook(run) {
  const previous = Error.prepareStackTrace;
  try {
    return run();
  } finally {
    Error.prepareStackTrace = previous;
  }
}
console.log(withSavedHook(() => new Error("kept").stack.split("\n")[0]));

Error.prepareStackTrace = undefined;
Error.prepareStackTrace = void 0;
const stack = new Error("still text").stack;
console.log(typeof stack, stack.split("\n")[0], Error.prepareStackTrace);
