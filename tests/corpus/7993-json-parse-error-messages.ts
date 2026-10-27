// JSON.parse syntax error messages, exactly as Node's V8 writes them: the
// expected token at the end of the input inside objects and arrays, the
// position as a UTF-16 offset with its line and column (\n, \r and \r\n
// end lines), the unexpected character named with the source (whole when
// short, ten units of context on each side when longer), and the special
// sources that name only themselves.
const inputs: string[] = [
  "", " ", "[", "[{", "{", '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":1,}', "{,", "{1:2}", "{'a':1}",
  '{"a" 1}', '{"a":1 "b":2}', "[1", "[1,", "[1,]", "[1 2]", "[,1]", '"abc', '"a\\', '"\\u12', '"\\u12x4"',
  '"\\u12"', '"\\x"', "tru", "nul", "fals", "t1", 'n"', "-", "-x", "1.", "1.e", "1e", "1e+", "01", "-01",
  "[01]", "+1", "1 2", "{} x", "[]]", "\u0001", '"\u0001"', '{"a":[1,{"b":', '[{"a":1},', '{"a":{"b":{}',
  "[[[", " [ \n { \n", "\n\n{", "\r\n\r\n{", "\r\r{", '{"a":tru}', "NaN", "Infinity", "undefined",
  "[object Object]", " NaN", "-Infinity", "[-]",
  // Positions count UTF-16 units: non-ASCII text before the error.
  '{"é":1 x}', '["😀" 1]', '{"😀😀":', '"é\u0001"', "é",
  // Long sources: the unexpected character with its context.
  '{"name":"some long value","other":x}', '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,]',
  'x{"name":"some long value","other":1}', '{"name":"some long value","other":1}x', '{"a":"0123456789abcdef"x}',
  '["😀😀😀😀😀😀", x, "😀😀😀😀😀😀"]', '["😀😀😀😀😀😀",x]', '{"k":[true,false,null,"s",1.5e3,-2] ]',
  '\n\n  {\n    "a": [1, 2,\n      3 4]\n  }',
];
for (const text of inputs) {
  try {
    JSON.parse(text);
    console.log(JSON.stringify(text), "parsed");
  } catch (e) {
    const err = e as Error;
    console.log(JSON.stringify(text), err.name, JSON.stringify(err.message));
  }
}
