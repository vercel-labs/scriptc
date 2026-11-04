import { createRequest, finishAll, finishOne, noteAll, work } from "./request.js";
import { markAll } from "./marks.js";

const request = createRequest("first", 3);
console.log(request.name, request.pending, request.destination, request.tasks.size);
finishOne(request, 2);
finishOne(request, 2);
console.log(request.pending, request.log);
noteAll(request);
finishAll(request);
console.log(request.pending, request.log.slice(-4));
const other = createRequest("second", 2);
console.log(work(other, "work"), other.pending, other.log);
console.log(markAll(other));
console.log(other.log);
