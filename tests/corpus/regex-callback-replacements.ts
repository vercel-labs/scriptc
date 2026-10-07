const calls: string[] = [];
console.log('ab ac'.replace(/a(b)?/g, (match: string, capture: string | undefined, offset: number, subject: string) => {
  calls.push(`${match}:${capture}:${offset}:${subject}`);
  return capture === undefined ? '$&' : capture.toUpperCase();
}));
console.log(calls.join('|'));
console.log('😀a😀'.replaceAll(/😀/gu, (match: string, offset: number) => `${offset}:${match}`));
console.log('😀x'.replace(/(?:)/gu, (_match: string, offset: number) => String(offset)));
console.log('2024-07'.replace(/(?<year>\d+)-(?<month>\d+)/, (match: string, year: string, month: string, offset: number, subject: string, groups: unknown) => {
  const values = groups as Record<string, string>;
  console.log(match, offset, subject, values.year, values.month, Object.getPrototypeOf(groups) === null);
  return `${month}/${year}`;
}));
const pattern = /a/g;
let count = 0;
console.log('aaa'.replace(pattern, () => { count++; pattern.lastIndex = 2; return String(count); }));
console.log(count, pattern.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
console.log('ba'.replace(sticky, (_match: string, offset: number) => String(offset)), sticky.lastIndex);
let missed = 0;
console.log('none'.replace(/z/g, () => { missed++; return 'bad'; }), missed);
try { console.log('aa'.replace(/a/g, () => { throw new Error('stop'); })); } catch(e) { if(e instanceof Error) console.log(e.message); }
try { console.log('aa'.replaceAll(/a/, () => 'bad')); } catch(e) { console.log(e instanceof TypeError); }
