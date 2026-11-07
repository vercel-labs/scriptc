// One generic declaration held at two signatures by two different functions, many times over, so
// that in a build divided into several objects some instance's interned closure and the closure of
// its identity root land in different objects. Each thread has its own function objects.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

interface Box<T> {
  v: T;
}
type NumFn = (box: Box<number>) => number;
type StrFn = (box: Box<string>) => string;

function pick0<T>(box: Box<T>): T {
  return box.v;
}
function asNumber0(): NumFn {
  return pick0;
}
function asString0(): StrFn {
  return pick0;
}
function pick1<T>(box: Box<T>): T {
  return box.v;
}
function asNumber1(): NumFn {
  return pick1;
}
function asString1(): StrFn {
  return pick1;
}
function pick2<T>(box: Box<T>): T {
  return box.v;
}
function asNumber2(): NumFn {
  return pick2;
}
function asString2(): StrFn {
  return pick2;
}
function pick3<T>(box: Box<T>): T {
  return box.v;
}
function asNumber3(): NumFn {
  return pick3;
}
function asString3(): StrFn {
  return pick3;
}
function pick4<T>(box: Box<T>): T {
  return box.v;
}
function asNumber4(): NumFn {
  return pick4;
}
function asString4(): StrFn {
  return pick4;
}
function pick5<T>(box: Box<T>): T {
  return box.v;
}
function asNumber5(): NumFn {
  return pick5;
}
function asString5(): StrFn {
  return pick5;
}
function pick6<T>(box: Box<T>): T {
  return box.v;
}
function asNumber6(): NumFn {
  return pick6;
}
function asString6(): StrFn {
  return pick6;
}
function pick7<T>(box: Box<T>): T {
  return box.v;
}
function asNumber7(): NumFn {
  return pick7;
}
function asString7(): StrFn {
  return pick7;
}
function pick8<T>(box: Box<T>): T {
  return box.v;
}
function asNumber8(): NumFn {
  return pick8;
}
function asString8(): StrFn {
  return pick8;
}
function pick9<T>(box: Box<T>): T {
  return box.v;
}
function asNumber9(): NumFn {
  return pick9;
}
function asString9(): StrFn {
  return pick9;
}
function pick10<T>(box: Box<T>): T {
  return box.v;
}
function asNumber10(): NumFn {
  return pick10;
}
function asString10(): StrFn {
  return pick10;
}
function pick11<T>(box: Box<T>): T {
  return box.v;
}
function asNumber11(): NumFn {
  return pick11;
}
function asString11(): StrFn {
  return pick11;
}

function numberSide(): NumFn[] {
  return [asNumber0(), asNumber1(), asNumber2(), asNumber3(), asNumber4(), asNumber5(), asNumber6(), asNumber7(), asNumber8(), asNumber9(), asNumber10(), asNumber11()];
}
function stringSide(): StrFn[] {
  return [asString0(), asString1(), asString2(), asString3(), asString4(), asString5(), asString6(), asString7(), asString8(), asString9(), asString10(), asString11()];
}
function numbersAgain(): number {
  let sum = 0;
  sum += asNumber0()({ v: 0 });
  sum += asNumber1()({ v: 1 });
  sum += asNumber2()({ v: 2 });
  sum += asNumber3()({ v: 3 });
  sum += asNumber4()({ v: 4 });
  sum += asNumber5()({ v: 5 });
  sum += asNumber6()({ v: 6 });
  sum += asNumber7()({ v: 7 });
  sum += asNumber8()({ v: 8 });
  sum += asNumber9()({ v: 9 });
  sum += asNumber10()({ v: 10 });
  sum += asNumber11()({ v: 11 });
  return sum;
}
function stringsAgain(): string {
  let text = "";
  text += asString0()({ v: "a" });
  text += asString1()({ v: "b" });
  text += asString2()({ v: "c" });
  text += asString3()({ v: "d" });
  text += asString4()({ v: "e" });
  text += asString5()({ v: "f" });
  text += asString6()({ v: "g" });
  text += asString7()({ v: "h" });
  text += asString8()({ v: "i" });
  text += asString9()({ v: "j" });
  text += asString10()({ v: "k" });
  text += asString11()({ v: "l" });
  return text;
}

function check(label: string): string {
  const a = numberSide();
  const b = stringSide();
  let same = 0;
  let names = 0;
  const keys = new Set<unknown>();
  for (let i = 0; i < a.length; i++) {
    const x: unknown = a[i];
    const y: unknown = b[i];
    if (x === y) same++;
    if (a[i]!.name === b[i]!.name && a[i]!.length === b[i]!.length) names++;
    keys.add(x);
    keys.add(y);
  }
  return `${label}: ${same} of ${a.length} same, ${names} named alike, ${keys.size} keys, ${numbersAgain()} ${stringsAgain()}`;
}

if (isMainThread) {
  console.log(check("main"));
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => {
    console.log(message);
  });
  worker.on("exit", (code) => {
    console.log("exit", code);
  });
} else {
  parentPort!.postMessage(check("worker"));
}
