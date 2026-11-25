// A reference read out of a value that was just made, inside an async
// function and inside a generator, kept across the suspension and after the
// function is done.
interface Page {
  words: number;
}
class Chapter {
  pages: Page[];
  constructor(pages: Page[]) {
    this.pages = pages;
  }
  opening(): Page {
    return this.pages[0]!;
  }
}
function pages(base: number): Page[] {
  const made: Page[] = [];
  for (let i = 0; i < 4; i++) made.push({ words: base + i });
  return made;
}
function chapter(base: number): Chapter {
  return new Chapter(pages(base));
}
function count(list: Page[]): number {
  let total = list.length * 1000;
  for (const page of list) total += page.words;
  return total;
}
function churn(): number {
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const spare = pages(600 + i);
    const other = chapter(700 + i);
    total += spare.length + other.pages.length;
  }
  return total;
}
let shelved: Page[] = [];
let marked: Page = { words: -1 };
async function read(): Promise<number> {
  await Promise.resolve();
  shelved = new Chapter(pages(10)).pages;
  marked = pages(20)[2]!;
  const mine = chapter(30).opening();
  const tail = pages(40).pop()!;
  await Promise.resolve();
  churn();
  return mine.words + tail.words;
}
async function fetched(): Promise<Page[]> {
  await Promise.resolve();
  return chapter(50).pages;
}
function* walk(): Generator<Page, number, void> {
  const kept = new Chapter(pages(60)).pages;
  yield pages(70)[1]!;
  churn();
  yield chapter(80).opening();
  return count(kept);
}
const readTotal = await read();
const fetchedPages = await fetched();
churn();
console.log(readTotal, count(shelved), marked.words, count(fetchedPages));
let walked = 0;
const steps = walk();
for (let step = steps.next(); ; step = steps.next()) {
  churn();
  if (step.done) {
    walked += step.value;
    break;
  }
  walked += step.value.words;
}
console.log(walked);
export {};
