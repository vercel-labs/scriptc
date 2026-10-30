'use strict';
// Functions and classes reached as dynamic values print their enumerable
// own properties after the tag, as Node prints them: a class's static
// properties, properties assigned to a function, cycles through them,
// and `[Function]` past the depth limit, where a cycle still shows.
const util = require('util');

function f() {}
f.x = 1;
f.label = 'f';
function g() {}
g.self = g;
function plain() {}
class A {}
class S extends A {
  static get hidden() {
    return 1;
  }
}
S.count = 3;
function show(value) {
  console.log(value);
}
show(f);
show(g);
show(S);
show(A);
show(plain);
function shallow(value) {
  console.log(util.inspect({ value }, { depth: 0 }));
}
shallow(f);
shallow(S);
shallow(A);
console.log(util.inspect(g, { depth: 0 }));
shallow(g);

// A class that reaches itself through its static properties is one cycle,
// whichever dynamic box of it the inspection meets.
class Loop {
  static get hidden() {
    return 1;
  }
}
Loop.self = Loop;
Loop.label = 'loop';
class Left {
  static get hidden() {
    return 2;
  }
}
class Right {
  static get hidden() {
    return 3;
  }
}
Left.other = Right;
Right.other = Left;
show(Loop);
show(Left);
show([Loop, Loop]);
show({ a: Left, b: Right });
