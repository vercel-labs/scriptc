// A JavaScript read of a name another library declares (`document`, `window`,
// `XMLHttpRequest`) but Node does not define resolves at run time, as every
// undeclared name does: the access throws a catchable ReferenceError naming
// the identifier, before any argument evaluates, and code that never runs
// never throws. The file needs no typeof test of the name for this: the only
// typeof guard here tests a different name.
"use strict";

function pageTitle() {
  return document.title;
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

const describe = (label, fn) => {
  try {
    console.log(`${label}: ${String(fn())}`);
  } catch (e) {
    console.log(`${label}: threw ${e.name}: ${e.message}`, e instanceof ReferenceError);
  }
};

console.log("defined:", typeof pageTitle, typeof viewport);
describe("document read", pageTitle);
describe("window read", () => viewport().width);
describe("member chain", () => document.body.children.length);
describe("call", () => alert("x"));
describe("comparison", () => window === undefined);

let evaluated = false;
describe("argument order", () =>
  window.open(
    (() => {
      evaluated = true;
      return "about:blank";
    })(),
  ),
);
console.log("argument evaluated:", evaluated);

if (typeof self !== "undefined") console.log("self:", self.location.href);
else console.log("self: unset");

const fallback = () => {
  try {
    return document.title;
  } catch {
    return "no document";
  }
};
console.log(fallback());
