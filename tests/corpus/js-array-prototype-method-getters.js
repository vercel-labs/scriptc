// A program-defined Array.prototype method name answers an array read the way
// the prototype chain does: a getter runs once per read, with the array as its
// receiver, and the value it returns is the read's value. The method table the
// prototype installs lazily leaves the program's definition alone.

let slices = 0;
const receivers = [];
Object.defineProperty(Array.prototype, "slice", {
  configurable: true,
  get() {
    slices++;
    receivers.push(this === Array.prototype ? "prototype" : Array.isArray(this) ? "array" : "other");
    return undefined;
  },
});

const list = JSON.parse("[1, 2]");
console.log("slice", list.slice, slices);
console.log("receivers", receivers.join(","));
console.log("slice again", list.slice, slices);
console.log("receivers", receivers.join(","));

// Reading a different method name leaves the program's own property alone.
console.log("join", typeof [].join, typeof Array.prototype.join);
console.log("slice after join", list.slice, slices);
console.log("receivers", receivers.join(","));

const custom = () => "custom";
let concats = 0;
Object.defineProperty(Array.prototype, "concat", {
  configurable: true,
  get() {
    concats++;
    return custom;
  },
});
const other = JSON.parse("[3, 4]");
console.log("concat", other.concat === custom, concats);
console.log("concat again", list.concat === custom, concats);

// A data property assigned over a method name is what an array reads, and
// deleting it makes the read undefined again.
Array.prototype.findLastIndex = "replaced";
console.log("findLastIndex", list.findLastIndex, Array.prototype.findLastIndex);
delete Array.prototype.findLastIndex;
console.log("after delete", list.findLastIndex);

// A read of the prototype itself runs the getter once, with the prototype as
// its receiver: the array reads above are separate reads.
console.log("prototype read", Array.prototype.slice, slices);
console.log("receivers", receivers.join(","));
