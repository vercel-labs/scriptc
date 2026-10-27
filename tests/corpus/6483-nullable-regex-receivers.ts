// Regex-argument string methods on a receiver the checker types
// `string | undefined` (an unchecked index read, ts-ignored): a string
// takes the regex lowering, undefined throws Node's TypeError.
const lines = "100 /srv/node1/a.txt\n2048 /srv/node22/b/c.bin";
const pairs = lines.split("\n").map((line) => {
  const [count, file] = line.trim().split(/\s+/) as [string | undefined, string | undefined];
  // @ts-ignore possibly undefined
  return `${count.replace(/0+$/, "")}:${file.replace(/^\/srv\/node\d+\//, "")}`;
});
console.log(pairs);

function parts(text: string): (string | undefined)[] {
  return text.split(",").map((s) => (s === "" ? undefined : s));
}

for (const value of parts("a-b-c,")) {
  try {
    // @ts-ignore possibly undefined
    console.log(value.replaceAll(/-/g, "+"), value.split(/-/).length, value.search(/c/));
  } catch (e) {
    console.log(e instanceof TypeError, (e as Error).message);
  }
}
