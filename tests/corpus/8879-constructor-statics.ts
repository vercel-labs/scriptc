// Statics read through an instance's constructor, `(this.constructor as
// typeof Model).table`: TypeScript types `constructor` as Function, so real
// code asserts it. The static that answers is the one the instance's own
// class resolves, as in Node: a subclass's redeclaration, or the inherited
// member where it declares none.

class Model {
  static table = "models";
  static prefix = "p_";
  static label(): string {
    return "model";
  }
  static describe(): string {
    return `${this.name}:${this.table}`;
  }
  static scaled(n: number, by = 2): number {
    return n * by;
  }
  where(): string {
    return (this.constructor as typeof Model).table;
  }
  viaAny(): string {
    return (this.constructor as any).table;
  }
  viaUnknown(): string {
    return (this.constructor as unknown as typeof Model).table;
  }
  viaShape(): string {
    return (this.constructor as { table: string } & Function).table;
  }
  qualified(): string {
    return (this.constructor as typeof Model).prefix + (this.constructor as typeof Model).table;
  }
  labelled(): string {
    return (this.constructor as typeof Model).label();
  }
  described(): string {
    return (this.constructor as typeof Model).describe();
  }
  scaled(n: number): string {
    return `${(this.constructor as typeof Model).scaled(n)},${(this.constructor as typeof Model).scaled(n, 3)}`;
  }
}
class User extends Model {
  static table = "users";
  static label(): string {
    return "user";
  }
  static scaled(n: number, by = 10): number {
    return n * by;
  }
}
// A subclass with other constructor arguments and no statics of its own.
class Session extends Model {
  id: number;
  constructor(id: number) {
    super();
    this.id = id;
  }
}
class Admin extends User {}

const models: Model[] = [new Model(), new User(), new Session(1), new Admin()];
for (const model of models) {
  console.log(
    model.where(),
    model.viaAny(),
    model.viaUnknown(),
    model.viaShape(),
    model.qualified(),
    model.labelled(),
    model.described(),
    model.scaled(2),
  );
}

// Through a parameter rather than `this`.
function tableOf(model: Model): string {
  return (model.constructor as typeof Model).table;
}
console.log(models.map(tableOf).join(","));

// A class that declares its constructor's type.
class Typed {
  declare ["constructor"]: typeof Typed;
  static unit = "base";
  unit(): string {
    return this.constructor.unit;
  }
}
class Metric extends Typed {
  static unit = "m";
}
console.log(new Typed().unit(), new Metric().unit());

// A static accessor: the getter runs with the instance's class as `this`.
class Resource {
  static get path(): string {
    return `/${this.name.toLowerCase()}s`;
  }
  path(): string {
    return (this.constructor as typeof Resource).path;
  }
}
class Invoice extends Resource {}
console.log(new Resource().path(), new Invoice().path());

// Error classes carry their codes this way.
class BaseError extends Error {
  static code = "E_BASE";
  get code(): string {
    return (this.constructor as typeof BaseError).code;
  }
}
class NotFound extends BaseError {
  static code = "E_NOT_FOUND";
}
function codeOf(error: BaseError): string {
  return error.code;
}
try {
  throw new NotFound("missing");
} catch (error) {
  console.log(codeOf(error as BaseError), codeOf(new BaseError("plain")));
}

// A hierarchy whose instances also take dynamic properties.
class Record {
  static kind = "record";
  kind(): string {
    return (this.constructor as typeof Record).kind;
  }
}
class Row extends Record {
  static kind = "row";
}
const row = new Row();
(row as any).extra = 1;
console.log(row.kind(), new Record().kind(), (row as any).extra);
