// String element reads that may fall outside the string still produce
// undefined: writes between a guard and the read, writes from closures,
// fractional, negative and inclusive bounds, and guards on another string.
function show(label: string, value: string | undefined): void {
  console.log(label, value === undefined ? "undefined" : JSON.stringify(value));
}

const word = "kite";

{
  let i = 3;
  if (i < word.length) {
    i++;
    show("bumped", word[i]);
  }
}

{
  let i = 0;
  if (i < word.length) {
    for (let k = 0; k < 6; k++) {
      show("inner", word[i]);
      i++;
    }
  }
}

{
  let text = "abcdef";
  const i = 4;
  if (i < text.length) {
    text = "ab";
    show("shrunk", text[i]);
  }
}

{
  let text = "abc";
  const shorten = (): void => {
    text = "a";
  };
  for (let i = 0; i < text.length; i++) {
    shorten();
    show("closure-text", text[i]);
  }
}

{
  let i = 0;
  const jump = (): void => {
    i += 3;
  };
  while (i < word.length) {
    jump();
    show("closure-index", word[i]);
  }
}

{
  const half = 0.5;
  if (half < word.length) show("half", word[half]);
  const before = -1;
  if (before < word.length) show("negative", word[before]);
  let down = 0;
  down = down - 1;
  if (down < word.length) show("minus", word[down]);
}

{
  const text = "abc";
  for (let i = 0; i <= text.length; i++) show("inclusive", text[i]);
}

{
  const long = "longer text";
  const short = "s";
  for (let i = 0; i < long.length; i++) if (i > 8) show("other", short[i]);
}

{
  const text = "abcd";
  for (let i = 0; i < text.length; i++) {
    show("ahead", text[i + 1]);
    i++;
    show("stepped", text[i]);
  }
}

{
  const text = "pq";
  let i = 0;
  let rest = 0;
  if (i < text.length) {
    [i, rest] = [7, 1];
    show("destructured", text[i]);
  }
  console.log("rest", rest);
}

function at(text: string, index: number): string | undefined {
  return index < text.length ? text[index] : "-";
}
show("param-frac", at("abc", 1.5));
show("param-neg", at("abc", -2));
show("param-ok", at("abc", 2));

function afterLoop(text: string): string | undefined {
  let i = 0;
  do {
    i++;
  } while (i < text.length);
  return text[i];
}
show("after-loop", afterLoop("xyz"));

let shared = 0;
function advance(): void {
  shared += 10;
}
function readShared(text: string): string | undefined {
  if (shared < text.length) {
    advance();
    return text[shared];
  }
  return "-";
}
show("module-index", readShared("abc"));
