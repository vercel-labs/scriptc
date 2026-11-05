import { createBoundary, createRequest, pendingOf, performWork, renderTask, replayTask } from "./tasks.js";

const request = createRequest();
const boundary = createBoundary();
renderTask(request, 1, null);
renderTask(request, 2, boundary);
replayTask(request, 3, 4);
console.log(request.abortableTasks.size, boundary.fallbackAbortableTasks.size, pendingOf(request));
console.log(performWork(request), request.abortableTasks.size, pendingOf(request));
console.log(request.currentTask, boundary.fallbackAbortableTasks.size);
