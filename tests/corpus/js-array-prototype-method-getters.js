// A program-defined Array.prototype property answers an array read the way
// the prototype chain does: a getter runs once per read, with the array as
// its receiver, and the value it returns is the read's value. Replacing a
// member the intrinsic table has refuses (t262-da §2.5, decision DA-2), so
// the program's members are names the table does not have.

let slices = 0;
const receivers = [];
Object.defineProperty(Array.prototype, "readSlice", {
  configurable: true,
  get() {
    slices++;
    receivers.push(this === Array.prototype ? "prototype" : Array.isArray(this) ? "array" : "other");
    return undefined;
  },
});

const list = JSON.parse("[1, 2]");
console.log("slice", list.readSlice, slices);
console.log("receivers", receivers.join(","));
console.log("slice again", list.readSlice, slices);
console.log("receivers", receivers.join(","));

// Reading a different name leaves the program's own property alone.
console.log("join", typeof [].join, typeof Array.prototype.join);
console.log("slice after join", list.readSlice, slices);
console.log("receivers", receivers.join(","));

const custom = () => "custom";
let concats = 0;
Object.defineProperty(Array.prototype, "readConcat", {
  configurable: true,
  get() {
    concats++;
    return custom;
  },
});
const other = JSON.parse("[3, 4]");
console.log("concat", other.readConcat === custom, concats);
console.log("concat again", list.readConcat === custom, concats);

// A data property assigned over an unused name is what an array reads, and
// deleting it makes the read undefined again.
Array.prototype.readFindLastIndex = "replaced";
console.log("findLastIndex", list.readFindLastIndex, Array.prototype.readFindLastIndex);
delete Array.prototype.readFindLastIndex;
console.log("after delete", list.readFindLastIndex);

// A read of the prototype itself runs the getter once, with the prototype as
// its receiver: the array reads above are separate reads.
console.log("prototype read", Array.prototype.readSlice, slices);
console.log("receivers", receivers.join(","));
