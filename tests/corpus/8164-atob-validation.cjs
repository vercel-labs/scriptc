// atob checks its input as Node does: only ASCII whitespace and the base64
// alphabet are allowed, '=' only at the end and at most twice, and a
// length the forgiving-base64 rules refuse is a different error.
"use strict";
const inputs = [
  "@@@",
  "a",
  "ab",
  "ab=",
  "ab==",
  "ab=c",
  "abc==",
  "a===",
  "ab===",
  " Y W J j ",
  "YQ",
  "Y Q = =",
  "YWJjZA==",
  "YWJjZA=",
  "\tYW\nJj\fZA\r==",
  "é",
  "YW-J",
  "",
];
const decode = (label, input) => {
  try {
    console.log(label, JSON.stringify(atob(input)));
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};
for (const input of inputs) decode(JSON.stringify(input), input);
decode("null", null);
decode("undefined", undefined);
decode("12", 12);
