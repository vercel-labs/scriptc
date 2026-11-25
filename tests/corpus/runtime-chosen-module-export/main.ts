import pick from './pick-cjs.cjs';
import AlwaysProd from './always-prod.cjs';
import AlwaysDev from './always-dev.cjs';
import umd from './umd-wrapper.cjs';
import Lib from './umd-factory.cjs';
import Thing from './classes.cjs';
import notFn from './not-a-function.cjs';
import alwaysNumber from './always-number.cjs';
import requireSide from './require-side.cjs';

// The default import is the value the module's executed branch stored.
console.log(pick('default'), AlwaysProd('always'), AlwaysDev('always'), umd('wrapped'));
console.log(Lib.greet('umd'), Lib.value);
const thing = new Thing('v');
console.log(thing.hello());
console.log(requireSide.bound(), requireSide.inline());
console.log(typeof notFn, (notFn as any)());
// A branch that stores a number: calling the import throws Node's exact
// TypeError, catchable where Node throws it.
console.log(typeof alwaysNumber);
try {
  (alwaysNumber as any)();
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
