export function Enum(item) {
  if (item === undefined || item === null) throw new Error("Enum undefined or empty");
  const values = Object.getOwnPropertyNames(item)
    .filter((key) => isNaN(key))
    .map((key) => item[key]);
  return { kind: "enum", anyOf: [...new Set(values)] };
}

export function describe(schema) {
  return `${schema.kind}(${schema.anyOf.map((v) => JSON.stringify(v)).join("|")})`;
}

export function tag(item, name) {
  item[name] = true;
}
