// String and Number methods through 'any'-typed values: string and number
// receivers run the real methods, other values keep JavaScript's answer.
const values: any[] = JSON.parse('["Straße İx", 1234.5678, {"substr": 1}, [1, 2]]');
const [text, num, obj, list] = values;
console.log(text.codePointAt(7), text.substr(-2), text.toLocaleUpperCase(), text.toLocaleLowerCase("az"));
console.log(text.trimRight(), text.isWellFormed(), text.toLocaleLowerCase(["TR"]));
console.log(num.toPrecision(6), num.toExponential(3), num.toPrecision(), num.toExponential());
console.log(list.at(-1), JSON.stringify(list.concat([3])));
for (const call of [() => obj.substr(0), () => num.codePointAt(0), () => text.toPrecision(2)]) {
  try {
    console.log(call());
  } catch (e) {
    console.log((e as Error).name + ": " + (e as Error).message);
  }
}
