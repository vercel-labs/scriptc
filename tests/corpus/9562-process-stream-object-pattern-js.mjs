// The same pattern in JavaScript, where the source is the stream object:
// a terminal member that is absent binds undefined instead of failing the
// declared boolean or number, and defaults apply.
const { isTTY, columns, fd } = process.stdout;
const { columns: width = 64, rows = 20 } = process.stderr;
const { isTTY: keyboard, isRaw } = process.stdin;

function show(label, value) {
  console.log(label, typeof value, value === undefined ? "absent" : String(value));
}

show("isTTY", isTTY);
show("columns", columns);
show("fd", fd);
show("width", width);
show("rows", rows);
show("keyboard", keyboard);
show("isRaw", isRaw);
console.log((isTTY ? "terminal" : "plain") + "/" + String(columns ?? width));
