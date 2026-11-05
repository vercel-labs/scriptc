// @flow
// Where Flow annotations stop, a Flow module follows JavaScript, as
// pre-class code relies on: ES5 constructors and prototype methods with
// unannotated parameters, functions that read `this`, expando members,
// `Array(n)`, and Function.prototype.bind as a value.

export function Component(props: mixed, context: mixed) {
  this.props = props;
  this.context = context;
  this.updates = [];
}

Component.prototype.setState = function (partialState, callback) {
  this.updates.push(partialState);
  if (typeof callback === 'function') callback(this.updates.length);
};

function describeSelf(): string {
  return 'component with ' + this.updates.length + ' updates';
}
Component.prototype.describe = describeSelf;

export function label(value: number): string {
  return 'value ' + value;
}
label.displayName = 'Label';

export function slots(count: number): number {
  const list = Array(count);
  list[0] = 'first';
  return list.length;
}

const bind = Function.prototype.bind;
export function bound(prefix: string): (text: string) => string {
  function join(text: string): string {
    return this + text;
  }
  return bind.call(join, prefix);
}
