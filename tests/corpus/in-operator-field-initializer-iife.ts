/**
 * An arrow the field initializer calls on the spot runs at the initializer's
 * position, so `in this` inside it sees the fields defined so far, as Node
 * does. An arrow the initializer only hands out runs later, when the whole
 * instance is built, so its answer sees every field.
 */
class Early {
  first = 1;
  laterSeen = (() => "later" in this)();
  firstSeen = (() => "first" in this)();
  missingSeen = (() => "missing" in this)();
  nestedSeen = (() => (() => "later" in this)())();
  genericSeen = (<T,>() => "later" in this)();
  later = 2;
}

const early = new Early();
console.log(
  early.laterSeen,
  early.firstSeen,
  early.missingSeen,
  early.nestedSeen,
  early.genericSeen,
);

class Escape {
  first = 1;
  getLater = () => "later" in this;
  later = 2;
}

const escape = new Escape();
console.log(escape.getLater());

/**
 * An immediately invoked async arrow that suspends resumes in a later job,
 * once the constructor has returned, so a membership test after the await
 * sees the fields defined after the initializer. A test before the await, or
 * past an await that does not run, still answers from the field order. When
 * only some path through the test reaches an await, its position is decided
 * while the program runs, not from the field order alone.
 */
class Suspends {
  first = 1;
  beforeAwait = (async () => {
    const seen = "later" in this;
    await null;
    return seen;
  })();
  afterAwait = (async () => {
    await null;
    return "later" in this;
  })();
  skippedAwait = (async () => {
    if (false) await null;
    return "later" in this;
  })();
  conditionalAwait = (async () => {
    if (this.first === 1) await null;
    return "later" in this;
  })();
  skippedConditionalAwait = (async () => {
    if (this.first === 0) await null;
    return "later" in this;
  })();
  skippedArmExpression = (async () => {
    const zero = this.first === 0;
    const waited = zero ? await null : 0;
    return waited === 0 && "later" in this;
  })();
  expressionBody = (async () => (await null, "later" in this))();
  operandAwait = (async () => await ("later" in this))();
  branchAwait = (async () => {
    if (this.first === 0) {
      await null;
      return "later" in this;
    } else {
      return "later" in this;
    }
  })();
  later = 2;
}

const suspends = new Suspends();
console.log(
  await suspends.beforeAwait,
  await suspends.afterAwait,
  await suspends.skippedAwait,
  await suspends.conditionalAwait,
  await suspends.skippedConditionalAwait,
  await suspends.skippedArmExpression,
  await suspends.expressionBody,
  await suspends.operandAwait,
  await suspends.branchAwait,
  "later" in suspends,
);
