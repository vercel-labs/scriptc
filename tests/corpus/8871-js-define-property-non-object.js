// Object.defineProperty / Object.defineProperties over a non-object target.
// Node evaluates every argument, then checks Type(O): a primitive target
// throws Node's TypeError instead of creating a wrapper. Object's sibling
// getOwnPropertyDescriptor is different: it applies ToObject, so a boolean,
// number, or string target is legal and a string's indices are own
// properties. A JavaScript source used to defer these calls to a compile
// fence, which threw a plain Error where Node throws a TypeError.
'use strict';

function report(label, fn) {
  try {
    const value = fn();
    console.log(label + ': ok ' + String(value));
  } catch (e) {
    console.log(label + ': ' + e.name + ': ' + e.message);
    console.log(label + ': is TypeError ' + (e instanceof TypeError) + ' ' + (e.constructor === TypeError));
  }
}

// defineProperty: any non-object target throws before the key is converted.
report('defineProperty bool', () => Object.defineProperty(true, 'foo', {}));
report('defineProperty number', () => Object.defineProperty(5, 'foo', {}));
report('defineProperty string', () => Object.defineProperty('abc', 'foo', {}));
report('defineProperty symbol', () => Object.defineProperty(Symbol('s'), 'foo', {}));
report('defineProperty null', () => Object.defineProperty(null, 'foo', {}));
report('defineProperty undefined', () => Object.defineProperty(undefined, 'foo', {}));

// defineProperties: the same Type(O) check with its own message.
report('defineProperties bool', () => Object.defineProperties(true, {}));
report('defineProperties number', () => Object.defineProperties(5, { a: {} }));
report('defineProperties string', () => Object.defineProperties('abc', {}));
report('defineProperties symbol', () => Object.defineProperties(Symbol('s'), {}));
report('defineProperties null', () => Object.defineProperties(null, {}));
report('defineProperties undefined', () => Object.defineProperties(undefined, {}));

// Every argument evaluates before the target check, so the key and the
// descriptor expression run (and their side effects land) before the throw.
const order = [];
report('order defineProperty', () => {
  order.push('target');
  return Object.defineProperty(
    true,
    (order.push('key'), 'foo'),
    (order.push('descriptor'), {}),
  );
});
console.log('order: ' + order.join(','));
const order2 = [];
report('order defineProperties', () =>
  Object.defineProperties((order2.push('target'), 5), (order2.push('props'), {})),
);
console.log('order: ' + order2.join(','));

// An object target still defines the property.
const target = {};
Object.defineProperty(target, 'x', { value: 1, enumerable: true });
Object.defineProperties(target, { y: { value: 2, enumerable: true } });
console.log('object target: ' + target.x + ' ' + target.y);
console.log('object target keys: ' + Object.keys(target).join(','));
console.log('descriptor: ' + JSON.stringify(Object.getOwnPropertyDescriptor(target, 'x')));

// getOwnPropertyDescriptor applies ToObject to a primitive: a string's
// index is an own (unwritable, enumerable) property, and a boolean or
// number wrapper has none of the looked-up names.
console.log('gopd string index: ' + JSON.stringify(Object.getOwnPropertyDescriptor('abc', 1)));
console.log('gopd string length: ' + Object.getOwnPropertyDescriptor('abc', 'length').value);
console.log('gopd string missing: ' + Object.getOwnPropertyDescriptor('abc', 'zz'));
console.log('gopd bool: ' + Object.getOwnPropertyDescriptor(true, 'foo'));
console.log('gopd number: ' + Object.getOwnPropertyDescriptor(5, 'foo'));
report('gopd null', () => Object.getOwnPropertyDescriptor(null, 'foo'));
report('gopd undefined', () => Object.getOwnPropertyDescriptor(undefined, 'foo'));
