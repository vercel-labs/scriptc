// A JavaScript module mutates the Dates it is handed (Date setters run on
// the checked-dynamic Date object).
export function advance(date, ms) {
  date.setTime(date.getTime() + ms);
  return date;
}
