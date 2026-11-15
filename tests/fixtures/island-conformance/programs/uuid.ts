import { NIL, parse, stringify, v4, v5, validate, version } from "uuid";

const id = v5("https://example.com/a", v5.URL);
console.log(id, validate(id), version(id));
const bytes = parse(id);
console.log(bytes.length, stringify(bytes) === id, NIL);
const random = v4();
console.log(validate(random), version(random), random.length, random !== v4());
console.log(validate("not-a-uuid"), typeof v4);
try {
  parse("nope");
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
