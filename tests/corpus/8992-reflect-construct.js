// Reflect.construct(target, argsList[, newTarget]): the dynamic tier builds
// through the target's [[Construct]], reading argsList as any array-like.
function Point(x, y) {
  this.x = x;
  this.y = y;
  this.sum = x + y;
}
Point.prototype.describe = function () { return this.x + "," + this.y; };
const fromArray = Reflect.construct(Point, [1, 2]);
console.log(fromArray instanceof Point, fromArray.x, fromArray.y, fromArray.describe());
const fromEmpty = Reflect.construct(Point, []);
console.log(fromEmpty.x, fromEmpty.y, fromEmpty.sum);
const arrayLike = Reflect.construct(Point, { length: 2, 0: "a", 1: "b" });
console.log(arrayLike.x, arrayLike.y, "ab");
const shorter = Reflect.construct(Point, { length: 5, 0: 1 });
console.log(shorter.x, shorter.y, shorter.sum);
// A constructor function's methods come from its `prototype` object, and
// the instance it builds inherits them.
function Pair(left, right) {
  this.left = left;
  this.right = right;
}
Pair.prototype.joined = function () { return this.left + "+" + this.right; };
const pair = Reflect.construct(Pair, ["l", "r"]);
console.log(pair instanceof Pair, pair.joined());

// A constructor that answers an object returns that object; one that answers
// a primitive keeps the instance built from its prototype.
function objectAnswer() { return { borrowed: true }; }
function primitiveAnswer() { return 7; }
console.log(Reflect.construct(objectAnswer, []).borrowed);
const primitive = Reflect.construct(primitiveAnswer, []);
console.log(primitive instanceof primitiveAnswer, typeof primitive, primitive.constructor === primitiveAnswer);

// The third argument is newTarget; passing the target itself is the same
// construction.
const explicit = Reflect.construct(Point, [3, 4], Point);
console.log(explicit instanceof Point, explicit.describe());

// Builtin constructors construct as usual.
const array = Reflect.construct(Array, [3]);
console.log(Array.isArray(array), array.length);
// The Object global read as a value (a direct `Reflect.construct(Object, …)`
// target is a stdlib-global snapshot the compiler fences).
const ObjectCtor = Object;
console.log(Reflect.construct(ObjectCtor, []).constructor === Object);

// Order: the target, then newTarget, then the argument list.
const order = [];
const traceArgs = { get length() { order.push("length"); return 0; } };
Reflect.construct(Point, traceArgs);
console.log(order.join(","));
try { Reflect.construct({}, traceArgs); } catch (error) { console.log(error.name, order.length); }
try { Reflect.construct(5, []); } catch (error) { console.log(error.name); }
try { Reflect.construct(Point, 1); } catch (error) { console.log(error.name, error.message); }
try { Reflect.construct(Point, [1], 7); } catch (error) { console.log(error.name); }

// A proxy target runs its construct trap with the target, the list and the
// proxy as newTarget; a non-object trap answer throws.
const trapTrace = [];
const constructible = function Base(value) { this.value = value; };
const proxy = new Proxy(constructible, {
  construct(target, args, newTarget) {
    trapTrace.push(args.length, newTarget === proxy, target === constructible);
    return { built: args[0] };
  },
});
console.log(Reflect.construct(proxy, ["x"]).built, trapTrace.join(","));
const refusing = new Proxy(constructible, { construct() { return 1; } });
try { Reflect.construct(refusing, []); } catch (error) { console.log(error.name); }
