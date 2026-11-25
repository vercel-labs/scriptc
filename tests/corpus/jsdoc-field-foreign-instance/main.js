const {
  Attribute,
  BufferAttribute,
  ConstructedHolder,
  Holder,
  Interleaved,
} = require("./shapes.js");

const holder = new Holder();
console.log(holder.item === undefined);

const buffer = new BufferAttribute();
holder.item = buffer;
console.log(holder.item === buffer);
console.log(holder.item instanceof BufferAttribute);
console.log(holder.item instanceof Attribute);

const interleaved = new Interleaved();
holder.item = interleaved;
console.log(holder.item === interleaved);
console.log(holder.item instanceof Interleaved);
console.log(holder.item instanceof Attribute);
console.log(holder.item === buffer);
console.log(holder.item === undefined);
console.log(holder.item.stride);

const constructed = new ConstructedHolder();
console.log(constructed.slot instanceof BufferAttribute);
constructed.slot = interleaved;
console.log(constructed.slot === interleaved);
console.log(constructed.slot instanceof Interleaved);
console.log(constructed.slot instanceof Attribute);
console.log(constructed.slot === buffer);
console.log(constructed.slot.stride);
