// A constructor-function "class" and the prototype chain React builds for
// Component and PureComponent: prototype member writes, one constructor's
// prototype taken from another, a prototype built by construction, and
// Object.assign over the result.
"use strict";

function Component(props) {
  this.props = props;
}
Component.prototype.isReactComponent = {};
Component.prototype.setState = function (partial) {
  return "set:" + partial;
};

function ComponentDummy() {}
ComponentDummy.prototype = Component.prototype;

function PureComponent(props) {
  this.props = props;
}
var pureComponentPrototype = (PureComponent.prototype = new ComponentDummy());
pureComponentPrototype.constructor = PureComponent;
Object.assign(pureComponentPrototype, Component.prototype);
pureComponentPrototype.isPureReactComponent = true;

const c = new Component({ id: 1 });
const p = new PureComponent({ id: 2 });
console.log(c.props.id, c.setState(1), p.props.id, p.setState(2));
console.log(p instanceof Component, p instanceof PureComponent, c instanceof PureComponent);
console.log(p.constructor === PureComponent, Object.getPrototypeOf(p) === pureComponentPrototype);
console.log(p.isReactComponent === c.isReactComponent, p.isPureReactComponent);
console.log(Object.keys(p).join(","));
