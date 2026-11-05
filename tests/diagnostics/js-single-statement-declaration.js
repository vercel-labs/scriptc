// ECMAScript early errors the TypeScript checker does not model: the body of
// a loop, a `with` statement, or an if clause admits only a Statement, and
// Annex B's function-declaration allowance never covers an async function, a
// generator, a class, or a lexical declaration. SC0007, reported at
// preflight — the shapes come from Test262's negative-parse suites.
while (false) function inLoop() {}
l: class inLabel {}
if (true) async function inIf() {}
if (false) il: function labelledInIf() {}
do function* inDoWhile() {} while (false);
