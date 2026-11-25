// Untyped JavaScript validating JSON.parse rows against a schema it reads by
// key name at run time: the schema is an object literal walked by its own
// keys, validators are class instances chosen by a table, a context object
// accumulates the outcome, and every row builds a result literal. Argument:
// the number of rows.
const rows = Number(process.argv[2] ?? "200000");

const schema = {
  id: { type: "number", min: 0, max: 1000000 },
  name: { type: "string", minLength: 2, maxLength: 40 },
  age: { type: "number", min: 0, max: 120 },
  active: { type: "boolean" },
  tags: { type: "array", items: { type: "string", minLength: 1 }, minLength: 1 },
  address: {
    type: "object",
    fields: {
      city: { type: "string", minLength: 1 },
      zip: { type: "string", minLength: 4, maxLength: 10 },
    },
  },
};

class NumberCheck {
  constructor(spec) {
    this.spec = spec;
  }
  check(value, context, path) {
    context.checked++;
    if (typeof value !== "number" || value < this.spec.min || value > this.spec.max)
      context.fail(path, "number");
  }
}
class StringCheck {
  constructor(spec) {
    this.spec = spec;
  }
  check(value, context, path) {
    context.checked++;
    if (
      typeof value !== "string" ||
      value.length < this.spec.minLength ||
      (this.spec.maxLength !== undefined && value.length > this.spec.maxLength)
    )
      context.fail(path, "string");
  }
}
class BooleanCheck {
  check(value, context, path) {
    context.checked++;
    if (typeof value !== "boolean") context.fail(path, "boolean");
  }
}
class ArrayCheck {
  constructor(spec, check) {
    this.spec = spec;
    this.item = check(spec.items);
  }
  check(value, context, path) {
    context.checked++;
    if (!Array.isArray(value) || value.length < this.spec.minLength) {
      context.fail(path, "array");
      return;
    }
    for (let i = 0; i < value.length; i++) this.item.check(value[i], context, `${path}[${i}]`);
  }
}
class ObjectCheck {
  constructor(spec, check) {
    this.spec = spec;
    this.fields = {};
    for (const key of Object.keys(spec.fields)) this.fields[key] = check(spec.fields[key]);
  }
  check(value, context, path) {
    context.checked++;
    if (value === null || typeof value !== "object") {
      context.fail(path, "object");
      return;
    }
    for (const key of Object.keys(this.fields)) {
      if (!(key in value)) {
        context.fail(`${path}.${key}`, "missing");
        continue;
      }
      this.fields[key].check(value[key], context, `${path}.${key}`);
    }
  }
}

const table = {
  number: (spec) => new NumberCheck(spec),
  string: (spec) => new StringCheck(spec),
  boolean: () => new BooleanCheck(),
  array: (spec) => new ArrayCheck(spec, check),
  object: (spec) => new ObjectCheck(spec, check),
};
function check(spec) {
  return table[spec.type](spec);
}

function makeDocument(count) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const name = i % 97 === 0 ? "x" : `user${i % 400}`;
    const age = i % 211 === 0 ? 140 : i % 118;
    parts.push(
      `{"id":${i},"name":"${name}","age":${age},"active":${i % 2 === 0},"tags":["t${i % 5}","u${i % 3}"],"address":{"city":"c${i % 7}","zip":"z${1000 + (i % 900)}"}}`,
    );
  }
  return `[${parts.join(",")}]`;
}

const validator = new ObjectCheck({ fields: schema }, check);
const data = JSON.parse(makeDocument(rows));
let failures = 0;
let checked = 0;
for (let i = 0; i < data.length; i++) {
  const context = {
    checked: 0,
    failed: 0,
    first: "",
    fail(path, expected) {
      this.failed++;
      if (this.first === "") this.first = `${path}:${expected}`;
    },
  };
  validator.check(data[i], context, "row");
  checked += context.checked;
  failures += context.failed;
  const result = { id: data[i].id, ok: context.failed === 0, first: context.first, seen: context.checked };
  if (i % 1000 === 0) checked += result.ok ? 1 : 0;
}
console.log(data.length, checked, failures, validator.fields.name.spec.maxLength);
