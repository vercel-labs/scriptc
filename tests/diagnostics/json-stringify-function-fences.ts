// JSON.stringify of a value that may itself be a function answers
// undefined for the function and text otherwise: refused by name.
function pick(flag: boolean): string | (() => string) {
  return flag ? "text" : () => "lazy";
}
const rootUnion = JSON.stringify(pick(true));

// A narrowed copy keeps its source object's properties. When the source
// type has a member no JSON writer handles, the call names both types.
interface Wide {
  id: number;
  index: Map<string, number>;
}
interface Narrow {
  id: number;
}
function narrow(wide: Wide): Narrow {
  return wide;
}
const linked = JSON.stringify(narrow({ id: 1, index: new Map() }));
