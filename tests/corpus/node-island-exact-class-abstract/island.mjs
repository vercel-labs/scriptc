export function probe(value) {
  return [value.hello(), typeof value.area, "area" in value].join(" ");
}

export function probeStatic(value) {
  return [value.describe(), typeof value.area, "area" in value].join(" ");
}
