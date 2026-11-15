// @requires-libnode
// An instance of a program class that extends Error, inside a Node island:
// a V8 Error whose own properties are the instance's fields, in the
// program's order, that is an instance of the class and of every class it
// extends, and whose methods run on the program's object.
import { fields, members, isInstance, keep, same, giveBack } from "err-view";

class HttpError extends Error {
  status: number;
  constructor(m: string, status: number) {
    super(m);
    this.name = "HttpError";
    this.status = status;
  }
  describe(): string {
    return this.name + ":" + this.status;
  }
}
class Invalid extends TypeError {
  field = "f";
}
class Base extends Error {
  kind(): string {
    return "base";
  }
}
class Derived extends Base {
  level = 2;
  kind(): string {
    return "derived";
  }
}

const http = new HttpError("gone", 410);
console.log(fields("http", http));
console.log(members("http", http, HttpError, ["status", "describe"]));
console.log("http is an Invalid =", isInstance(http, Invalid));
keep("http", http);
console.log("http identity =", same("http", http), giveBack(http) === http);

const invalid = new Invalid("bad");
console.log(fields("invalid", invalid));
console.log(members("invalid", invalid, Invalid, ["field"]));
console.log("invalid is an HttpError =", isInstance(invalid, HttpError));
keep("invalid", invalid);
console.log("invalid identity =", same("invalid", invalid), giveBack(invalid) === invalid);

const derived = new Derived("deep");
console.log(fields("derived", derived));
console.log(members("derived", derived, Derived, ["level", "kind"]));
console.log("derived is a Base =", isInstance(derived, Base));
const base = new Base("plain base");
console.log(members("base", base, Base, ["kind"]));
console.log("base is a Derived =", isInstance(base, Derived));
keep("derived", derived);
console.log("derived identity =", same("derived", derived), giveBack(derived) === derived);

// The program's typed writes and the island's reads are of one object.
http.status = 503;
http.message = "unavailable";
console.log(members("http after native writes", http, HttpError, ["status", "describe"]));
console.log(fields("http after native writes", http));
