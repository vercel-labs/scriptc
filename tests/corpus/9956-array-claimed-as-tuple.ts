// Column definitions of a CSV reader. A column's cells are parsed by a
// constructor, or, for a cell that holds a list, by the one constructor in
// an array. The reader keeps them under its own parser type: the
// constructor becomes the parser, and the array becomes the one-element
// tuple the assertion names.
type Cell = typeof Number | typeof String | typeof Boolean;
type Parser = (text: string, header: string, row?: unknown) => unknown;
type Column = { header: string; parse: Cell | readonly Cell[] };

const columns: Column[] = [
  { header: "price", parse: Number },
  { header: "title", parse: String },
  { header: "sold", parse: Boolean },
  { header: "tags", parse: [String] },
  { header: "sizes", parse: [Number] },
];

// Per header: a parser, the tuple of a list cell's parser, or a constant
// every row gets.
const readers: Record<string, Parser | [Parser] | string> = { source: "import-7" };
for (const column of columns) readers[column.header] = column.parse as Parser | [Parser];

const row: Record<string, string> = { price: "12.5", title: "lamp", sold: "", tags: "a;b", sizes: "3;4" };
for (const header of Object.keys(readers)) {
  const reader = readers[header]!;
  if (typeof reader === "string") {
    console.log(header, "constant", reader);
    continue;
  }
  const list = Array.isArray(reader);
  const parse = list ? reader[0] : reader;
  const text = row[header] ?? "";
  console.log(header, list, list ? reader.length : 0, parse === Number, parse === String, parse === Boolean);
  console.log(" ", JSON.stringify(parse(text, header, undefined)), JSON.stringify(parse("", header, row)));
  if (list) console.log(" ", JSON.stringify(text.split(";").map((part) => parse(part, header))));
}
