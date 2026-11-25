export function total(measures: Measure[], unit: Unit): number {
  let sum = 0;
  for (const measure of measures) if (measure.unit === unit) sum += measure.amount;
  return sum;
}
