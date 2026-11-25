// structuredClone copies a primitive wrapper object: the copy is the same kind
// over the same primitive, so it answers valueOf, Object.prototype.toString and
// instanceof like the original. (A wrapper reached twice is copied twice where
// Node shares one copy, and a wrapper cannot cross a message yet.)
const show = (label, run) => {
  try {
    const copy = run();
    console.log(
      label,
      Object.prototype.toString.call(copy),
      String(copy),
      String(copy.valueOf()),
      copy instanceof Number,
      copy instanceof String,
    );
  } catch (error) {
    console.log(label, error.name, error.message);
  }
};

show("number", () => structuredClone(new Number(1)));
show("string", () => structuredClone(new String("a")));
show("boolean", () => structuredClone(new Boolean(true)));
show("object", () => structuredClone(Object(2)));
show("nested", () => structuredClone({ n: new Number(5) }).n);
show("in array", () => structuredClone([new String("x")])[0]);
show("plain data", () => structuredClone({ a: [1, "two", true] }).a[1]);
