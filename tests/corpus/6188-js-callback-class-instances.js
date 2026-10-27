// Class instances passed to an untyped JavaScript callback (chardet's
// `recognisers.map((rec) => rec.match(context))`): the callback reads its
// parameter as a dynamic value, and method calls on it reach the
// instances' compiled methods, inherited ones included.

class Recogniser {
  name() {
    return 'base';
  }
  match(input) {
    return input.length > 2 ? `${this.name()}:${input.length}` : null;
  }
}
class ShiftJis extends Recogniser {
  name() {
    return 'Shift_JIS';
  }
}
class Big5 extends Recogniser {
  name() {
    return 'Big5';
  }
  match(input) {
    return `big5 ${super.match(input)}`;
  }
}
class Utf8 {
  match(input) {
    return `utf8:${input}`;
  }
}

const one = [new ShiftJis(), new ShiftJis()];
console.log(one.map((rec) => rec.match('abc')).join(' '));

const mixed = [new ShiftJis(), new Big5(), new Utf8()];
console.log(JSON.stringify(mixed.map((rec) => rec.match('abcd'))));
console.log(mixed.filter((rec) => rec.match('ab') !== null).length);
mixed.forEach((rec, i) => console.log(i, rec.match('xyz')));
