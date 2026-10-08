class Label {
  text = "label";
}
function render(value: boolean | number | bigint | Label): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}`;
  return value.text;
}
function template(value: string | number | Label): string {
  if (typeof value === "number" || typeof value === "string") return `value=${value}`;
  return value.text;
}
console.log(render(true), render(false), render(-0), render(NaN), render(Infinity));
console.log(render(12n), render(new Label()), template(2.5), template("text"));
