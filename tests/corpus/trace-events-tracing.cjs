// node:trace_events — the tracing objects' bookkeeping: createTracing's
// option checks, the categories string it keeps (duplicates included), the
// enabled flag enable()/disable() flip, getEnabledCategories' sorted and
// de-duplicated answer across every enabled object, and the object's shape
// (no own keys, the Tracing inspect view).
'use strict';
const te = require('trace_events');
const util = require('util');
const show = (label, fn) => {
  try {
    const value = fn();
    console.log(label, '=> ok', typeof value === 'object' && value !== null ? 'object' : JSON.stringify(value));
  } catch (error) {
    console.log(label, '=>', error.constructor.name, String(error.code), JSON.stringify(error.message));
  }
};

show('createTracing()', () => te.createTracing());
show('createTracing({})', () => te.createTracing({}));
show('createTracing({ categories: 5 })', () => te.createTracing({ categories: 5 }));
show('createTracing({ categories: [] })', () => te.createTracing({ categories: [] }));
show('createTracing({ categories: [5] })', () => te.createTracing({ categories: [5] }));
show('createTracing({ categories: ["v8", 7] })', () => te.createTracing({ categories: ['v8', 7] }));
show('createTracing(5)', () => te.createTracing(5));

const first = te.createTracing({ categories: ['v8', 'node', 'v8'] });
console.log('categories:', first.categories);
console.log('enabled:', first.enabled);
console.log('keys:', Object.keys(first).length);
console.log('typeof:', typeof first);
console.log('list (none):', String(te.getEnabledCategories()));

first.enable();
first.enable();
console.log('after enable:', first.enabled, '| list:', te.getEnabledCategories());

const second = te.createTracing({ categories: ['custom', 'v8'] });
second.enable();
console.log('two enabled:', te.getEnabledCategories());
second.disable();
console.log('one enabled:', te.getEnabledCategories());
first.disable();
first.disable();
console.log('after disable:', first.enabled, '| list:', String(te.getEnabledCategories()));

console.log('inspect:', util.inspect(first));

// A tracer the program drops while disabled is freed with its handle: a loop
// of them keeps no state and does not slow the enabled-categories query,
// which walks only the enabled tracers.
for (let i = 0; i < 2000; i++) {
  const discarded = te.createTracing({ categories: [`audit:discarded-${i}`] });
  if (discarded.enabled) throw new Error('a new tracer starts disabled');
}
console.log('discarded tracers:', String(te.getEnabledCategories()));
const churn = te.createTracing({ categories: ['audit:churn'] });
churn.enable();
console.log('churn enabled:', te.getEnabledCategories());
churn.disable();
console.log('churn disabled:', String(te.getEnabledCategories()));
churn.enable();
console.log('churn re-enabled:', te.getEnabledCategories());
churn.disable();
console.log('churn off again:', String(te.getEnabledCategories()));

// The categories array stays alive under the reads that validate it: an
// element answered by an inherited getter can remove options.categories,
// dropping the object's only reference while later elements are still read.
class InheritedCategories extends Array {
  get 0() {
    delete getterOptions.categories;
    return 'node';
  }
}
const getterOptions = {};
getterOptions.categories = (() => {
  const categories = new Array(2);
  categories[1] = 42;
  Object.setPrototypeOf(categories, InheritedCategories.prototype);
  return categories;
})();
let getterError = null;
try {
  te.createTracing(getterOptions);
} catch (error) {
  getterError = error;
}
console.log(
  'categories getter:',
  getterError === null ? 'none' : getterError.code,
  '|',
  getterError === null ? '' : getterError.message,
  '| deleted:',
  !('categories' in getterOptions),
);
