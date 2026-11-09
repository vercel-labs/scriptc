// A diagnostic after a `void 0` declarator on its line. The build reads such
// a declarator as a cast to the open type (frontend/js-void-initializers.ts);
// the diagnostic names the column of the file as written, and the frame shows
// the lines as written, the declarators on the neighbouring lines included.
function settle(task) {
  let before = void 0;
  var value = void 0; const limit = 42; limit = 43;
  var after = void 0, more = void 0;
  value = task(limit);
  return [before, value, after, more];
}
console.log(settle(String));
