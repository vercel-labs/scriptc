// Object.defineProperties on every receiver Object.defineProperty serves: an object literal of
// accessors behind its declared type and behind an assertion, a class instance (new names, the
// constructor's `this`, declared fields), a function, an untyped object, a null-prototype object,
// frozen, sealed and non-extensible objects, primitives, an Error. Each module is one receiver.
import "./accessor-literal-returned-asserted.ts";
import "./accessor-literal-local-asserted.ts";
import "./class-instance.ts";
import "./class-this-constructor.ts";
import "./function.ts";
import "./any-object.ts";
import "./null-prototype.ts";
import "./frozen-sealed.ts";
import "./primitive-targets.ts";
import "./error-instance.ts";
import "./object-typed.ts";
import "./view-literal-no-accessor.ts";
import "./class-instance-as-interface.ts";
import "./class-declared-field.ts";
import "./record-behind-unknown.ts";
