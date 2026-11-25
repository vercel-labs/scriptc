import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  formatDistance,
  isValid,
  parseISO,
  startOfMonth,
} from "date-fns";

const start = new Date(2026, 0, 15, 10, 30);
const later = addDays(start, 45);
console.log(format(start, "yyyy-MM-dd HH:mm"), format(later, "EEEE, MMMM do yyyy"));
console.log(differenceInCalendarDays(later, start), formatDistance(start, later));
console.log(isValid(parseISO("2026-02-30")), isValid(parseISO("2026-02-28")));
console.log(format(startOfMonth(later), "yyyy-MM-dd"), later instanceof Date, later.getDate());
const days = eachDayOfInterval({ start, end: addDays(start, 3) });
console.log(days.length, days.map((d) => format(d, "EEE")).join(","));
