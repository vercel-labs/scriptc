// A truthiness test of an expression the checker types `void`: an empty base
// method whose result is tested, directly and through a binding, and a
// subclass that overrides it to answer a value. The checker infers `void`
// from the base body it sees, while Node tests whatever the call returned, so
// the test sees the route the override answers. An operand that really is
// undefined tests false, after evaluating once for its effects.
'use strict';

class Router {
  "~findRoute"(_event) {}
  find(event) {
    const route = this["~findRoute"](event);
    if (route) return route;
    return null;
  }
}

class RouteTable extends Router {
  "~findRoute"(event) {
    if (event.path === "/") return { path: event.path, matched: true };
    return undefined;
  }
}

class Counter {
  count = 0;
  bump() {
    this.count += 1;
  }
  check() {
    if (this.bump()) return "truthy";
    return `falsy:${this.count}`;
  }
}

function report(label, fn) {
  try {
    console.log(`${label}: ${JSON.stringify(fn())}`);
  } catch (e) {
    console.log(`${label}: threw ${e.name}: ${e.message}`);
  }
}

let ran = 0;
function plain() {
  ran += 1;
}

report("base route", () => new Router().find({ path: "/" }));
report("subclass route", () => new RouteTable().find({ path: "/" }));
report("subclass miss", () => new RouteTable().find({ path: "/missing" }));
report("negated", () => !new Router()["~findRoute"]({ path: "/" }));
report("negated override", () => !new RouteTable()["~findRoute"]({ path: "/" }));
report("effects", () => new Counter().check());
report("direct test", () => (new Router()["~findRoute"]({}) ? "yes" : "no"));
report("direct override", () => (new RouteTable()["~findRoute"]({ path: "/" }) ? "yes" : "no"));
report("plain call", () => (plain() ? "yes" : "no"));
report("plain negated", () => !plain());
report("effects count", () => ran);
