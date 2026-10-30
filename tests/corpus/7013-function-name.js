'use strict';
// A function value's `name` is set where it is created: an anonymous
// function definition takes the name of the binding, property or field it
// initializes (NamedEvaluation), a symbol key names it `[description]` (the
// empty string without one), and a value copied between bindings keeps the
// name it already had.
var fromAssignment;
fromAssignment = function () {};
var fromAssignmentArrow;
fromAssignmentArrow = () => {};
var fromAssignmentGen;
fromAssignmentGen = function* () {};
// A parenthesized assignment target is not an IdentifierReference, so the
// value it stores stays unnamed (13.15.2 step 1.c: the parentheses, not the
// binding, decide).
var parenthesizedTarget;
(parenthesizedTarget) = function () {};
var parenthesizedArrowTarget;
((parenthesizedArrowTarget)) = () => {};

class Fields {
  method = function () {};
  arrow = () => {};
}

const named = function namedExpression() {};
const arrowNamed = () => {};

const literal = {
  shorthandMethod() {},
  arrow: () => {},
  fn: function () {},
  keyed: function namedKeyed() {},
};
const described = Symbol('described');
const undescribed = Symbol();
const symbolLiteral = {
  [described]: () => {},
  [undescribed]: () => {},
};

const copy = fromAssignment;
// A binding assigned a second function takes that function's identity: the
// read's own type is what the box carries, not the first value it held.
let reassigned;
reassigned = function (a) {};
reassigned = function (b, c) {};
let executorParameter;
new Promise(function (resolve, reject) {
  executorParameter = resolve;
});

function describe(label, value) {
  console.log(label, JSON.stringify(value.name), value.length);
}
describe('fromAssignment', fromAssignment);
describe('fromAssignmentArrow', fromAssignmentArrow);
describe('fromAssignmentGen', fromAssignmentGen);
describe('parenthesizedTarget', parenthesizedTarget);
describe('parenthesizedArrowTarget', parenthesizedArrowTarget);
describe('fieldMethod', new Fields().method);
describe('fieldArrow', new Fields().arrow);
describe('namedExpression', named);
describe('arrowNamed', arrowNamed);
describe('literalShorthand', literal.shorthandMethod);
describe('literalArrow', literal.arrow);
describe('literalFn', literal.fn);
describe('literalKeyed', literal.keyed);
describe('symbolLiteralDescribed', symbolLiteral[described]);
describe('symbolLiteralUndescribed', symbolLiteral[undescribed]);
describe('copied', copy);
describe('reassigned', reassigned);
describe('executorParameter', executorParameter);
