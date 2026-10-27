// Reads of properties an object lacks, from the same untyped sites many
// times: they answer undefined until the object, its prototype, or the
// prototype link changes, and Object.prototype members still answer.
function read(object) {
  return object.flag;
}
function readName(object) {
  return object.name;
}
function describe(object) {
  return [object.toString === Object.prototype.toString, typeof object.constructor, typeof object.hasOwnProperty].join();
}
function callIt(object) {
  try {
    return object.run();
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
}

const seen = [];
const plain = { name: "plain" };
for (let i = 0; i < 3; i++) seen.push(read(plain));
plain.flag = "added";
seen.push(read(plain));
delete plain.flag;
seen.push(read(plain));
console.log(seen.join());

// A prototype that gains, changes and loses the key.
const base = { kind: "base" };
const child = Object.create(base);
child.name = "child";
const fromProto = [];
for (let i = 0; i < 3; i++) fromProto.push(read(child));
base.flag = "inherited";
fromProto.push(read(child));
base.flag = "changed";
fromProto.push(read(child));
delete base.flag;
fromProto.push(read(child));
console.log(fromProto.join());

// Objects of one shape with different prototypes, read from one site.
const left = Object.create({ flag: "left" });
const right = Object.create({ other: 1 });
left.name = "l";
right.name = "r";
const mixed = [];
for (let i = 0; i < 3; i++) mixed.push(read(left), read(right));
console.log(mixed.join());

// Changing the prototype link of an object whose absent read was cached.
const moved = { name: "moved" };
for (let i = 0; i < 3; i++) read(moved);
Object.setPrototypeOf(moved, { flag: "after setPrototypeOf" });
console.log(read(moved));
Object.setPrototypeOf(moved, null);
console.log(read(moved), readName(moved));

// A longer prototype chain.
const grand = { flag: "grand" };
const parent = Object.create(grand);
const deep = Object.create(parent);
console.log(read(deep), read(Object.create(Object.create({}))));

// Object.prototype members and missing methods still answer as in Node.
const bare = { name: "bare" };
for (let i = 0; i < 3; i++) describe(bare);
console.log(describe(bare), describe({ other: 2 }));
for (let i = 0; i < 3; i++) callIt(bare);
console.log(callIt(bare));
bare.run = () => "ran";
console.log(callIt(bare));

// Many shapes through one site.
const shapes = [];
for (let i = 0; i < 12; i++) {
  const object = { name: `s${i}` };
  object[`k${i}`] = i;
  if (i % 3 === 0) object.flag = i;
  shapes.push(object);
}
let total = 0;
for (let round = 0; round < 4; round++)
  for (const object of shapes) total += read(object) === undefined ? 1 : 100;
console.log(total, shapes.map(readName).join());
