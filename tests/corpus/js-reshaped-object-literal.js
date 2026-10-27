// An object literal the program reshapes at run time (runtime-keyed
// writes, defineProperty, delete): every read sees the live object, not
// the layout TypeScript inferred for the literal (ansi-styles'
// assembleStyles shape).
const styles = {
  modifier: { reset: [0, 0], bold: [1, 22] },
  color: { red: [31, 39], green: [32, 39] },
};

function assemble() {
  const codes = new Map();
  for (const [groupName, group] of Object.entries(styles)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles[styleName] = { open: `<${style[0]}>`, close: `</${style[1]}>` };
      group[styleName] = styles[styleName];
      codes.set(style[0], style[1]);
    }
    Object.defineProperty(styles, groupName, { value: group, enumerable: false });
  }
  Object.defineProperty(styles, "codes", { value: codes, enumerable: false });
  styles.color.close = "</color>";
  styles.color.ansi = (code) => `[${code}]`;
  Object.defineProperties(styles, {
    double: { value: (n) => n * 2, enumerable: false },
  });
  return styles;
}

const ansi = assemble();
console.log(Object.keys(ansi).join(","));
console.log(ansi.red.open, ansi.color.red.close, ansi.color.close, ansi.color.ansi(5));
console.log(ansi.codes.get(31), ansi.codes.size, ansi.double(21));
console.log(ansi.modifier.bold === ansi.bold, Object.keys(ansi.color).join(","));
for (const [name, style] of Object.entries(ansi)) console.log(name, style.open, style.close);

const table = { a: 1, b: 2, c: 3 };
const drop = (key) => {
  delete table[key];
};
drop("b");
table["d" + 1] = 4;
console.log(JSON.stringify(table), Object.keys(table).length, "b" in table);
