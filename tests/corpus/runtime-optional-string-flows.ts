const suffixes = ['.alpha', '.beta'];
function suffix(path: string): string {
  const values = suffixes;
  for (let i = 0, n = values.length; i < n; i++) {
    const extension = values[i];
    if (path.endsWith(extension)) return extension;
  }
  return '';
}
function strip(value: string): string { return value.charAt(0) === '#' ? value.substring(1) : value; }
function combine(value: string): string { value = strip(value); value += '_'; return value; }
console.log(suffix('a.alpha').length, combine('#a'));
['a.beta'].map(path => suffix(path).length).forEach(n => console.log(n));
const absent: string[] = [];
function unchecked(): string { return absent[0]; }
try { console.log(unchecked().length); } catch (error) { console.log(error instanceof TypeError); }
function update(value: string): string { value += '_'; return value; }
console.log(update(absent[0]));
