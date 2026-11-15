// A chalk-style recursive hybrid: a callable whose members are callables of the same type.
interface Style {
  (s: string): string;
  open: string;
  close: string;
}
function style(open: string, close: string): Style {
  const fn = ((s: string) => open + s + close) as Style;
  fn.open = open;
  fn.close = close;
  return fn;
}
const bold = style("<b>", "</b>");
const styles: Record<string, Style> = { bold, em: style("<i>", "</i>") };
console.log(bold("x"), styles.em!("y"), styles.bold === bold, bold.open);
