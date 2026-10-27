// Untyped strings compared with string literals (ASCII, non-ASCII, emoji,
// empty) in a switch and in === / !==, against strings and other kinds.
function kind(t) {
  switch (t) { case "div": return 1; case "span": return 2; case "héllo": return 3; case "😀": return 4; case "": return 5; default: return 0; }
}
var tags = ["div", "span", "héllo", "😀", "", "di", "divx", 1, null, undefined, "spa" + "n"];
console.log(tags.map(kind).join(","), "a" === tags[0], tags[1] === "span", tags[2] !== "héllo");
