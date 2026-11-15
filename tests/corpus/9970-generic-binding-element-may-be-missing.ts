// A form: every field names the constructor that parses its input (String,
// Number, Boolean, or a one-element list for a repeated field). Generic
// functions read each field of the list they are given through the
// constraint. The program also resizes arrays through a generic helper, so
// no array is known to be free of holes: the loop variable of every instance
// can be undefined as well, and its member reads still go through every
// layout the list mixes.
type Parser = typeof String | typeof Number | typeof Boolean;

interface Field {
  readonly label: string;
  readonly hint: string | null;
  readonly parse: Parser | ReadonlyArray<Parser>;
  readonly help?: string;
  readonly alias?: string;
}

interface Page {
  readonly name: string;
  readonly fields: ReadonlyArray<Field>;
  readonly pages?: ReadonlyArray<Page>;
}

const age = { label: "age", hint: "years", parse: Number, help: "whole" } as const;
const member = { label: "member", hint: null, parse: Boolean, help: "paid up", alias: "m" } as const;
const pets = { label: "pets", hint: null, parse: [String] } as const;
const city = { label: "city", hint: null, parse: String, help: "where" } as const;

const person = { name: "person", fields: [age, member, pets] } as const;
const address = { name: "address", fields: [city, member] } as const;
const book: Page = { name: "book", fields: [], pages: [person, address] };

function resize<T>(items: T[], size: number): T[] {
  items.length = size;
  return items;
}

// Member reads: one every layout stores, one only some store, an optional
// chain and a truthiness test.
function parsers<T extends ReadonlyArray<Field>>(fields: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const field of fields) {
    out[field.label] = field.parse;
    if (field.hint) out[`${field.label}.hint`] = field.hint;
    if (field.alias) out[`alias.${field.alias}`] = field.label;
    out[`${field.label}.help`] = field.help?.length ?? -1;
  }
  return out;
}

// The held constructor itself: tested as a list, compared, called, named.
function parsed<T extends ReadonlyArray<Field>>(fields: T, input: string): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [at, field] of fields.entries()) {
    const parse = field.parse;
    out[`${at}.${field.label}`] = Array.isArray(parse) ? parse.length : parse === Boolean ? "flag" : (parse as Parser)(input);
    out[`${at}.${field.label}.by`] = Array.isArray(parse) ? "list" : (parse as Parser).name;
  }
  return out;
}

function show(what: string, table: Record<string, unknown>): void {
  for (const key of Object.keys(table)) {
    const value = table[key];
    const name =
      value === Boolean ? "Boolean" : value === Number ? "Number" : value === String ? "String" : Array.isArray(value) ? `list of ${value.length}` : String(value);
    console.log(what, key, typeof value, name, typeof value === "function" ? value("12") : "-");
  }
}

console.log(resize([1, 2], 3).length);

show("mixed", parsers([...person.fields, ...(book.pages ?? []).flatMap((page) => page.fields), ...address.fields]));
show("constant", parsers(person.fields));
show("interface", parsers(book.pages![1]!.fields));
show("mixed parsed", parsed([...person.fields, ...(book.pages ?? []).flatMap((page) => page.fields), ...address.fields], "7"));
show("constant parsed", parsed(person.fields, "7"));
show("interface parsed", parsed(book.pages![1]!.fields, "7"));

// A list that really has a hole: the member read of the missing element
// throws, after the elements before it were read.
try {
  show("holed", parsers(resize([...address.fields, ...(book.pages ?? []).flatMap((page) => page.fields)], 9)));
} catch (error) {
  console.log("holed", error instanceof TypeError, (error as Error).message);
}
