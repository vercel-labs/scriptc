// @exit: 1
// An ES module imports a CommonJS module that require()s it back: requiring
// an ES module that is still evaluating is Node's ERR_REQUIRE_CYCLE_MODULE,
// thrown at the require call, where the CommonJS module runs.
console.log('main: start');
import './b.cjs';
console.log('main: end');
export const value = 'main';
