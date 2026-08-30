try {
  throw new TypeError("something failed");
} catch (err) {
  if (err instanceof TypeError) {
    console.log(err.message);
  }
}

try {
  throw new RangeError("value out of range");
} catch (err) {
  if (err instanceof RangeError) {
    console.log(err.name);
    console.log(err.message);
  }
}
