// ECMAScript early errors the TypeScript checker does not model: a statement
// list may not declare one lexical name twice, and a lexical name may not be
// `var`-declared in the same list (Block : { StatementList }, and a switch's
// case block is one such list). Both are SC0005/SC0006, reported at
// preflight — the constructs come from Test262's negative-parse suites.
{
  class collide {}
  async function collide() {}
}

switch (1) {
  case 1:
    let scoped = 1;
    break;
  case 2:
    var scoped = 2;
    break;
}
