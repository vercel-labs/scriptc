// The web stream classes as objects: an instance's prototype is the class's
// prototype, it owns no properties (so Object.keys and
// Object.getOwnPropertyNames are empty), and for-in visits the class's
// enumerable members in the order Node's classes define them. The `in`
// operator answers for those members and for absent ones, and a prototype
// accessor is an enumerable, configurable getter.
const forIn = (value) => {
  const keys = [];
  for (const key in value) keys.push(key);
  return keys.join(",");
};
const describeMember = (proto, name) => {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (descriptor === undefined) return "none";
  return `${"get" in descriptor ? typeof descriptor.get : "data"}:${descriptor.enumerable}:${descriptor.configurable}`;
};
const classes = [
  ["readable", ReadableStream, () => new ReadableStream(), "locked"],
  ["reader", ReadableStreamDefaultReader, () => new ReadableStream().getReader(), "closed"],
  ["writable", WritableStream, () => new WritableStream(), "locked"],
  ["writer", WritableStreamDefaultWriter, () => new WritableStream().getWriter(), "desiredSize"],
  ["transform", TransformStream, () => new TransformStream(), "readable"],
  ["count", CountQueuingStrategy, () => new CountQueuingStrategy({ highWaterMark: 2 }), "size"],
  ["bytes", ByteLengthQueuingStrategy, () => new ByteLengthQueuingStrategy({ highWaterMark: 16 }), "size"],
  ["encoder", TextEncoderStream, () => new TextEncoderStream(), "encoding"],
  ["decoder", TextDecoderStream, () => new TextDecoderStream(), "encoding"],
];
for (const [label, cls, make, member] of classes) {
  const value = make();
  const proto = Object.getPrototypeOf(value);
  console.log(
    label,
    proto === cls.prototype,
    proto.constructor === cls,
    Object.getOwnPropertyNames(value).join(","),
    Object.keys(value).join(","),
    forIn(value),
    member in value,
    "no-such-member" in value,
    describeMember(proto, member),
  );
}

// The prototype's own names are the members for-in visits plus the
// constructor, and a method descriptor is an enumerable data property (as
// Node's spec-defined stream classes have them).
const readProto = Object.getPrototypeOf(new ReadableStream());
console.log("proto-names", Object.getOwnPropertyNames(readProto).join(","));
console.log("getReader-descriptor", describeMember(readProto, "getReader"));

// instanceof against the class values themselves.
console.log(
  "instanceof",
  new ReadableStream() instanceof ReadableStream,
  new ReadableStream().getReader() instanceof ReadableStreamDefaultReader,
  new WritableStream() instanceof WritableStream,
  new WritableStream().getWriter() instanceof WritableStreamDefaultWriter,
  new TransformStream() instanceof TransformStream,
  new CountQueuingStrategy({ highWaterMark: 2 }) instanceof CountQueuingStrategy,
  new TextEncoderStream() instanceof TextEncoderStream,
  new TextDecoderStream() instanceof TextDecoderStream,
);

// A property a program adds to a stream is the instance's own: it appears
// in getOwnPropertyNames and Object.keys, comes first in for-in, and `in`,
// hasOwnProperty and getOwnPropertyDescriptor see it.
{
  const added = new ReadableStream();
  added.label = "x";
  console.log(
    "added",
    Object.getOwnPropertyNames(added).join(","),
    Object.keys(added).join(","),
    forIn(added),
    "label" in added,
    "no-such-member" in added,
    Object.hasOwn(added, "label"),
    Object.getOwnPropertyDescriptor(added, "label").value,
  );
}
