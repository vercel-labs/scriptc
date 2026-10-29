// Builtins read into any- and unknown-typed slots hold the values Node reads.
function take(x: unknown): any {
  return x;
}
function give(): any {
  return Math;
}

const record: Record<string, unknown> = {
  json: JSON,
  math: Math,
  buffer: Buffer,
};
const loose: any = {
  JSON,
  Reflect,
  k: Map,
  bytes: Uint8Array,
  clone: structuredClone,
};
const list: any[] = [JSON, Math, atob, btoa];
const json: any = record.json;
const math: any = record.math;

console.log(typeof json, typeof math, typeof loose.Reflect, typeof loose.clone);
console.log(
  json === loose.JSON,
  json === list[0],
  math === list[1],
  math === give(),
);
console.log(
  take(JSON) === json,
  take(Map) === loose.k,
  take(Buffer) === record.buffer,
);

console.log(json.stringify({ a: [1, "x"] }), json.parse("[2,3]").length);
console.log(math.max(3, 9, 4), math.PI.toFixed(5), list[1].sqrt(16));
console.log(loose.Reflect.ownKeys({ b: 1, c: 2 }));
console.log(new loose.k([[1, "one"]]).get(1), new loose.bytes(3).length);
console.log((record.buffer as any).from("hi").toString("hex"));
console.log(loose.clone({ n: [1, 2] }).n[1], list[2]("aGk="), list[3]("hi"));
console.log(math.max.name, math.max.length, json.parse.name, loose.clone.name);

console.log(Math, JSON, Reflect);
console.log({ nested: { math: record.math } });
console.log(Object.prototype.toString.call(math), String(json));
console.log(JSON.stringify({ math, json }));
console.log(
  Object.keys(math).length,
  Object.getOwnPropertyNames(json).join(","),
);
