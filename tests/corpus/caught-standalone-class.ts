class Marker {
  value = 7;
}
class Other {
  value = 12;
}
class Unused { value = 0; }
const original = new Marker();
function classify(value: unknown): void {
  try {
    throw value;
  } catch (error) {
    console.log(error instanceof Marker, error instanceof Other, error instanceof Unused);
    if (error instanceof Marker) console.log(error.value, error === original);
  }
}
try {
  throw original;
} catch (error) {
  console.log(error instanceof Marker, error instanceof Other, error instanceof Unused);
  if (error instanceof Marker) {
    error.value++;
    console.log(error === original, original.value);
  }
  const alias: unknown = error;
  console.log(alias === original);
  try {
    throw error;
  } catch (again) {
    console.log(again instanceof Marker);
    if (again instanceof Marker) console.log(again === original, again.value);
  }
}
classify(original);
classify(new Other());
classify(7);
classify("marker");
classify({ value: 7 });
