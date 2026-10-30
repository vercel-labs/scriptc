// Untyped code calling methods on an instance of a JS class whose own
// properties live in a property bag: methods declared as arrow-function
// fields (own properties), prototype methods, prototype methods replaced or
// shadowed after construction, accessors on the prototype, and calls of
// members that are not functions. Each call must see what the instance
// holds at that moment and bind `this` to the instance.
'use strict';

class Context {
  status = 200;
  headers = {};
  label = 'ctx';
  header = (name, value) => {
    this.headers[name] = value;
    return this;
  };
  json = (body) => `${this.status} ${JSON.stringify(body)} ${JSON.stringify(this.headers)}`;
  constructor(label) {
    this.label = label;
  }
  describe() {
    return `${this.label}/${this.status}`;
  }
  get upper() {
    return this.label.toUpperCase();
  }
  shout() {
    return this.upper + '!';
  }
}

// Constant method names: the calls a framework's untyped code makes.
const calls = {
  describe: (t) => t.describe(),
  header: (t, name, value) => t.header(name, value),
  json: (t, body) => t.json(body),
  shout: (t) => t.shout(),
  extra: (t, n) => t.extra(n),
  status: (t) => t.status(),
  missing: (t) => t.missing(),
  upper: (t) => t.upper(),
};

function call(target, method, ...args) {
  return calls[method](target, ...args);
}

function put(target, key, value) {
  target[key] = value;
}

const c = new Context('first');
console.log(call(c, 'describe'));
console.log(call(call(c, 'header', 'x-a', '1'), 'json', { ok: true }));
put(c, 'status', 404);
console.log(call(c, 'json', [1, 2]), call(c, 'describe'), call(c, 'shout'));

// A field method replaced through untyped code, and an own property that
// shadows a prototype method.
put(c, 'json', (body) => `replaced ${body}`);
put(c, 'describe', function () {
  return `own describe of ${this.label}`;
});
console.log(call(c, 'json', 'x'), call(c, 'describe'));

// A prototype method replaced after construction reaches every instance
// that does not shadow it.
const d = new Context('second');
Context.prototype.describe = function () {
  return `patched ${this.label}`;
};
console.log(call(d, 'describe'), call(c, 'describe'));

// A prototype method added after construction.
Context.prototype.extra = function (n) {
  return `${this.label} extra ${n}`;
};
console.log(call(d, 'extra', 3));

// Members that are not functions.
for (const name of ['status', 'missing', 'upper']) {
  try {
    call(d, name);
  } catch (error) {
    console.log(error instanceof TypeError, error.message);
  }
}

// Many calls in a row stay consistent with the instance's current state.
let out = '';
for (let i = 0; i < 4; i++) {
  call(d, 'header', `h${i}`, String(i));
  put(d, 'status', 200 + i);
  out += call(d, 'json', i) + '\n';
}
process.stdout.write(out);
