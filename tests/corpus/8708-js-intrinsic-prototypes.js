// Builtin intrinsics as ordinary checked objects (t262-da A1): every
// prototype and constructor the intrinsic table names is one object, its
// members are the runtime's interned functions, its attributes are Node's,
// and the runtime's existing singletons (Object.prototype,
// Array.prototype, Error.prototype) are filled in place rather than
// replaced.
//
// The primitive wrappers (String, Number, Boolean, BigInt, Symbol) and
// Date keep the builders the runtime already had, so their prototypes are
// not asserted here; the object-shaped intrinsics below are the table's.
const lines = [];
const show = (name, value) => lines.push(name + "=" + String(value));

// The prototype a value answers is the intrinsic object `X.prototype`
// reads as, and the intrinsic graph is the standard's.
show("objectProto", Object.prototype === Object.getPrototypeOf({}));
show("arrayProto", Array.prototype === Object.getPrototypeOf([]));
show("mapProto", Map.prototype === Object.getPrototypeOf(new Map()));
show("setProto", Set.prototype === Object.getPrototypeOf(new Set()));
show("regexpProto", RegExp.prototype === Object.getPrototypeOf(/a/));
show("functionProto", Function.prototype === Object.getPrototypeOf(function () {}));
show("errorProto", Error.prototype === Object.getPrototypeOf(new Error("x")));
show("objectProtoProto", Object.getPrototypeOf(Object.prototype) === null);
show("arrayProtoProto", Object.getPrototypeOf(Array.prototype) === Object.prototype);
show("mapProtoProto", Object.getPrototypeOf(Map.prototype) === Object.prototype);
show("regexpProtoProto", Object.getPrototypeOf(RegExp.prototype) === Object.prototype);
show("funcProtoProto", Object.getPrototypeOf(Function.prototype) === Object.prototype);
show("errorProtoProto", Object.getPrototypeOf(Error.prototype) === Object.prototype);

// A method read through the prototype and through the receiver are one
// function, for a string key and for a symbol key.
show("arrayPushSame", Array.prototype.push === [].push);
show("arrayIterSame", Array.prototype[Symbol.iterator] === [][Symbol.iterator]);
show("objectHasOwnSame", Object.prototype.hasOwnProperty === {}.hasOwnProperty);
show("mapGetSame", Map.prototype.get === new Map().get);
show("setHasSame", Set.prototype.has === new Set().has);
show("functionCall", typeof Function.prototype.call);
show("functionBind", typeof Function.prototype.bind);
show("regexpExec", typeof RegExp.prototype.exec);
show("regexpTest", typeof RegExp.prototype.test);
show("errorName", Error.prototype.name);
show("errorMessage", Error.prototype.message);

// The attributes are the ones the standard gives a builtin member.
const push = Object.getOwnPropertyDescriptor(Array.prototype, "push");
show("pushWritable", push.writable);
show("pushEnumerable", push.enumerable);
show("pushConfigurable", push.configurable);
show("pushLength", push.value.length);
show("pushName", push.value.name);

// An accessor member is the table's getter, which reads the receiver's own
// internal slot.
const size = Object.getOwnPropertyDescriptor(Map.prototype, "size");
show("sizeGetter", typeof size.get);
show("sizeGetterName", size.get.name);
show("sizeGetterLength", size.get.length);
show("sizeSetter", size.set);
show("sizeEnumerable", size.enumerable);
show("sizeConfigurable", size.configurable);
const map = new Map();
map.set("a", 1);
const sizeGetter = size.get;
show("sizeRead", typeof sizeGetter === "function" ? sizeGetter.call(map) : "none");
show("mapOwnGet", Map.prototype.hasOwnProperty("get"));
show("arrayOwnPush", Array.prototype.hasOwnProperty("push"));

// Adding a member is allowed; the object is an ordinary one, and the write
// lands on the singleton the receiver reads through.
Array.prototype.addedByProgram = 7;
show("addedMember", Array.prototype.addedByProgram);
show("addedOwn", Array.prototype.hasOwnProperty("addedByProgram"));

// The same object, read twice.
show("protoIdentity", Map.prototype === Map.prototype);

for (const line of lines.sort()) console.log(line);
