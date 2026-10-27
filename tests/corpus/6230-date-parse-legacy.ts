// Date.parse and new Date(string) follow V8's date-string grammar: the ES5
// date-time format first, then the legacy forms Node accepts (RFC 1123 and
// RFC 2822 HTTP dates, Date#toString output, month names, slashes, AM/PM,
// zone names and numeric offsets). Strings without a zone are local time,
// so every input is parsed under several zones, including DST transitions.
const fixed = [
  "Mon, 01 Jan 2024 00:00:00 GMT",
  "Wed, 21 Oct 2015 07:28:00 GMT",
  "Sun, 06 Nov 1994 08:49:37 GMT",
  "Sunday, 06-Nov-94 08:49:37 GMT",
  "Sun Nov  6 08:49:37 1994",
  "Tue, 2 Jan 2024 03:04:05 +0100",
  "2 Jan 2024 03:04 -0800",
  "Mon Jan 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)",
  "Thu Jan 01 1970 00:00:00 GMT-0500 (EST)",
  "Jan 5",
  "1/2",
  "1/2/3",
  "2024/01/02",
  "2024/01/02 10:00",
  "2024-01-02 10:00:00",
  "2024-01-02T10:00:00",
  "2024-01-02T10:00:00.5",
  "2024-01-02T10:00:00.123456Z",
  "2024-01-02T10:00:00+0530",
  "2024-01-02T24:00:00Z",
  "2024-01-02T24:00:01Z",
  "2024-01-02T1:00Z",
  " 2024-01-01",
  "2024-01-01 ",
  "Jan 2, 2024",
  "January 2, 2024 10:00 PM",
  "12:00 am Jan 1 2024",
  "12:00 pm Jan 1 2024",
  "13:00 pm Jan 1 2024",
  "Jan 1 2024 10:00 GMT+5",
  "Jan 1 2024 10:00 UTC+0530",
  "Jan 1 2024 10:00 +05:30",
  "Jan 1 2024 10:00 PST",
  "Jan 1 2024 10:00 edt",
  "Jan 1 2024 10:00 XYZ",
  "Jan 1 2024 10.30",
  "10:20:30 Jan 1 2024",
  "Jan 1 2024 10:: GMT",
  "Jan 1 2024 (a (nested) comment) 10:00",
  "Jan 1 2024 10:00)",
  "foo 2024-01-01",
  "foo2024",
  "May 2024",
  "2024 May 3",
  "3 May 2024",
  "May 3 99",
  "May 3 49",
  "May 3 50",
  "Feb 29 2023",
  "Feb 30 2024 GMT",
  "Dec 31 1969 23:59:59.999 GMT",
  "2024-13-01",
  "2024-02-31T00:00:00Z",
  "+002024-01-01",
  "-000000-01-01",
  "-000001-01-01T00:00:00Z",
  "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z",
  "Sat, 13 Sep 275760 00:00:00 GMT",
  "Sat, 13 Sep 275760 00:00:01 GMT",
  "-271821-04-20T00:00:00Z",
  "Jan 1 9999999 GMT",
  "2024-01-01T10:00:00\u0000junk",
  "Jan 1 2024",
  "\uFEFFJan 1 2024",
  "Jan 1 2024 été",
  "0",
  "12",
  "2024",
  "20240",
  "",
  "garbage",
];
// A deterministic generator of date-like strings over V8's token classes.
let seed = 20240101;
function next(n: number): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
}
const pieces = ["Mon", "Tue,", "Wednesday", "Jan", "january", "FEB", "Sept", "dec", "ma", "1", "01", "2", "12", "13", "24", "31", "32", "59", "60", "99", "100", "2024", "1970", "0", "000", "0000", "123456", "-", "+", ":", "::", ".", ",", "/", " ", "\t", "(", ")", "(x)", "GMT", "UTC", "UT", "Z", "T", "t", "PST", "edt", "AM", "pm", "+0100", "-0800", "+01:00", "-8", "GMT+2", "GMT-0530", "999", "1000000", "x", "10:00", "23:59:59", "24:00", "12:30:45.123", "2024-01-15", "2024-01-15T10:00", "T10:00:00Z", "Jan1", "1Jan"];
const generated: string[] = [];
for (let i = 0; i < 1500; i++) {
  let s = "";
  const n = 1 + next(6);
  for (let j = 0; j < n; j++) s += pieces[next(pieces.length)]! + (next(3) === 0 ? " " : "");
  generated.push(s);
}
for (const zone of ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]) {
  process.env.TZ = zone;
  console.log("zone", zone);
  for (const s of fixed) console.log(JSON.stringify(s), Date.parse(s), new Date(s).getTime());
  let valid = 0;
  let sum = 0;
  let hash = 0;
  for (const s of generated) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) continue;
    valid++;
    sum = (sum + (t % 1000003)) % 1000000007;
    hash = (hash * 31 + (t % 65521)) % 2147483647;
  }
  console.log("generated", generated.length, "valid", valid, sum, hash);
}
// An HTTP conditional GET (the fresh package's comparison).
const lastModified = "Sun, 31 Dec 2023 00:00:00 GMT";
const ifModifiedSince = "Mon, 01 Jan 2024 00:00:00 GMT";
console.log("fresh", Date.parse(lastModified) <= Date.parse(ifModifiedSince));
