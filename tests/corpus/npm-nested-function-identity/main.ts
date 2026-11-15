// A function a dependency declares inside another function, or inside a
// loop, is a new function every time the declaration runs: two of them are
// different objects, and a property written on one is not on the other.
// One declared at the top of the module is one function.
import {
  area,
  getShared,
  makeCounter,
  makeDial,
  makeEcho,
  makeLabel,
  makeRelay,
  makeSteps,
  shared,
  totalOf,
} from "dial-kit";

const volts = makeDial("V");
const amps = makeDial("A");
console.log("dial:", volts(1), amps(2), volts === amps, volts.unit, amps.unit);

const first = makeCounter();
const second = makeCounter();
first(5);
first(5);
second(1);
console.log("counter:", totalOf(first), totalOf(second), first === second);

const near = makeEcho("near");
const far = makeEcho("far");
console.log("echo:", near(3), far(4), near === far);

const top = makeLabel("top");
const side = makeLabel("side");
console.log("label:", top("!"), top.text, side.text, top === side);

const relayA = makeRelay();
const relayB = makeRelay();
console.log("relay:", relayA(0), relayB(1), relayA === relayB, new Set([relayA, relayB]).size);

const steps = makeSteps(3);
console.log("steps:", steps.length, new Set(steps).size, steps[0] === steps[1], steps[2]!(4));

console.log("area:", area(2, 3));
console.log("shared:", shared(7), getShared() === shared, getShared().unit);
