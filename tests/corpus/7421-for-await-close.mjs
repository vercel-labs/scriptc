// The same early exits in JavaScript: a for await loop that returns,
// throws or breaks closes its async generator, including one that reaches
// the loop as an untyped parameter, and a source whose return() is still
// running finishes before the code after the loop.
const log = [];

async function* letters(tag) {
  try {
    yield "a";
    yield "b";
  } finally {
    log.push(`${tag} finally`);
  }
}

async function firstLetter(source) {
  for await (const c of source) return c;
}

async function failOn(source, target) {
  for await (const c of source) {
    if (c === target) throw new Error(`failed on ${c}`);
    log.push(`kept ${c}`);
  }
}

async function* upperUntil(source, stop) {
  for await (const c of source) {
    if (c === stop) return;
    yield c.toUpperCase();
  }
}

log.push(`first ${await firstLetter(letters("param-return"))}`);
try {
  await failOn(letters("param-throw"), "b");
} catch (e) {
  log.push(`caught ${e.message}`);
}
for await (const c of upperUntil(letters("stage-return"), "b")) log.push(`upper ${c}`);
let ticks = 0;
const tick = () => {
  log.push(`tick ${ticks}`);
  if (++ticks < 4) process.nextTick(tick);
};
process.nextTick(tick);
for await (const c of letters("break")) {
  log.push(`break ${c}`);
  break;
}
log.push("after break");
await new Promise((resolve) => setTimeout(resolve, 1));
console.log(log.join("\n"));
