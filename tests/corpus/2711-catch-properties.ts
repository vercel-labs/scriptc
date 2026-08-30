try {
  throw new TypeError("test error");
} catch (err: any) {
  console.log(err.message);
  console.log(err.name);
}

try {
  throw new RangeError("out of range");
} catch (err: any) {
  console.log(err.message);
  console.log(err.name);
}

try {
  throw new Error("plain");
} catch (err: any) {
  console.log(typeof err.message);
}
