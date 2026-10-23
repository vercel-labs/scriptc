// The libnode bridge: the C ABI of packages/runtime/src/scr_node_bridge.h
// over Node's C++ embedder API. It is built against one exact Node release
// (build-pack.mjs) and ships in that release's libnode pack next to
// libnode; the scriptc runtime dlopens it on the first call into Node and
// never includes a Node or V8 header itself.
//
// One environment per process, created from Node's built-in startup
// snapshot. Node keeps its hands off process-wide state that scriptc owns:
// no default signal handling, no debug-signal handler or inspector, no
// stdio reinitialization, one platform worker thread. Node's process exit
// (process.exit, an uncaught exception) goes to the runtime's exit
// sequence.
//
// One loop (scope-B NI-3). Once the runtime calls host_loop, its queues
// live on Node's: its microtasks are V8 microtasks, its ticks, timers and
// immediates are Node's (scheduled through the bootstrap's helpers), and
// its I/O is watched from Node's libuv loop (uv_poll handles over the fds
// the runtime reports, one prepare handle whose ref is the runtime's
// liveness, an idle handle while runtime work is ready without any fd).
// Calls into JavaScript therefore do not drain queues themselves: the
// runtime's checkpoints do, through `checkpoint`, and Node's own after
// every callback it dispatches.
#include "scr_node_bridge.h"

#include <dlfcn.h>
#include <node.h>
#include <node_buffer.h>
#include <node_api.h>
#include <node_version.h>
#include <uv.h>
#include <v8.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::Global;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::Locker;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::TryCatch;
using v8::Value;

const ScrNodeBridgeHost *g_host = nullptr;
void DropAllHandles();
void DropAllExports();
void FlushReleasedExports();
std::unique_ptr<node::MultiIsolatePlatform> g_platform;
node::EmbedderSnapshotData::Pointer g_snapshot;
std::unique_ptr<node::CommonEnvironmentSetup> g_setup;
Locker *g_locker = nullptr;
Global<Function> g_call;
// The bootstrap's hosted-loop helpers (scr_node_island_host.cjs).
Global<Function> g_set_timer, g_clear_timer, g_ref_timer, g_refresh_timer;
Global<Function> g_set_immediate, g_clear_immediate, g_ref_immediate;
Global<Function> g_next_tick, g_emit;
Global<Function> g_load; // the bootstrap's module loader (NI-4)
Global<Function> g_shared_push; // the loader hooks' binding updates (NI-6)
void SharedTable(const FunctionCallbackInfo<Value> &info);
void SharedGet(const FunctionCallbackInfo<Value> &info);
void SharedTdz(const FunctionCallbackInfo<Value> &info);

char *Copy(const std::string &text, size_t *len) {
  char *out = static_cast<char *>(std::malloc(text.size() + 1));
  if (out == nullptr) std::abort();
  std::memcpy(out, text.data(), text.size());
  out[text.size()] = '\0';
  if (len != nullptr) *len = text.size();
  return out;
}

// V8's stack limit follows the stack the runtime calls in from: its main
// thread's, or an async fiber's (a few hundred KiB, mapped elsewhere), so
// JavaScript entered from a fiber neither trips a false stack overflow nor
// overruns the fiber. Restored when the entry returns.
uintptr_t g_stack_limit = 0;

struct StackLimit {
  uintptr_t previous;
  explicit StackLimit(Isolate *isolate) : previous(g_stack_limit) {
    uintptr_t want = g_host->stack_limit();
    if (want != 0 && want != g_stack_limit) {
      isolate->SetStackLimit(want);
      g_stack_limit = want;
    }
  }
  ~StackLimit() {
    if (previous != 0 && previous != g_stack_limit) {
      g_setup->isolate()->SetStackLimit(previous);
      g_stack_limit = previous;
    }
  }
};

// The start of the runtime's stack when the caller runs on it (see the
// v8::base::Stack definitions at the end of this file), else 0.
uintptr_t HostStackStart() {
  return g_host != nullptr && g_host->stack_start != nullptr ? g_host->stack_start() : 0;
}

Local<String> Utf8(Isolate *isolate, const char *text, size_t len) {
  return String::NewFromUtf8(isolate, text, NewStringType::kNormal, static_cast<int>(len))
      .ToLocalChecked();
}

Local<String> Utf8(Isolate *isolate, const char *text) {
  return Utf8(isolate, text, std::strlen(text));
}

std::string ToStdString(Isolate *isolate, Local<Value> value) {
  String::Utf8Value text(isolate, value);
  return *text != nullptr ? std::string(*text, text.length()) : std::string();
}

// The outcome of an exception the dispatcher itself did not catch (a stack
// overflow, for example): an Error copy with its message.
std::string ThrownOutcome(Isolate *isolate, Local<Context> context, Local<Value> exception) {
  Local<Value> message = exception;
  if (exception->IsObject()) {
    Local<Value> own;
    if (exception.As<Object>()->Get(context, Utf8(isolate, "message")).ToLocal(&own))
      message = own;
  }
  Local<String> quoted;
  if (!v8::JSON::Stringify(context, message->ToString(context).ToLocalChecked()).ToLocal(&quoted))
    return "T{\"error\":{\"kind\":0,\"message\":\"\"}}";
  return "T{\"error\":{\"kind\":0,\"message\":" + ToStdString(isolate, quoted) + "}}";
}

// The bootstrap's settle(id, outcome) for asynchronous calls.
void Settle(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  uint32_t id = info[0]->Uint32Value(isolate->GetCurrentContext()).FromMaybe(0);
  std::string outcome = ToStdString(isolate, info[1]);
  g_host->settle(id, outcome.data(), outcome.size());
}

uint32_t Uint32Arg(const FunctionCallbackInfo<Value> &info, int i) {
  return info[i]->Uint32Value(info.GetIsolate()->GetCurrentContext()).FromMaybe(0);
}

// run(kind, token): a runtime job Node's queues dispatched.
void Run(const FunctionCallbackInfo<Value> &info) {
  g_host->run(Uint32Arg(info, 0), Uint32Arg(info, 1));
}

// listen(event, name, listener, add, once): island process listeners.
void Listen(const FunctionCallbackInfo<Value> &info) {
  std::string name = ToStdString(info.GetIsolate(), info[1]);
  g_host->listen(Uint32Arg(info, 0), name.c_str(), Uint32Arg(info, 2), Uint32Arg(info, 3) != 0,
                 Uint32Arg(info, 4) != 0);
}

void SetMethod(Local<Context> context, Local<Object> target, const char *name,
               v8::FunctionCallback callback) {
  target
      ->Set(context, Utf8(context->GetIsolate(), name),
            Function::New(context, callback).ToLocalChecked())
      .Check();
}

bool TakeFunction(Isolate *isolate, Local<Context> context, Local<Object> from, const char *name,
                  Global<Function> *to) {
  Local<Value> value;
  if (!from->Get(context, Utf8(isolate, name)).ToLocal(&value) || !value->IsFunction())
    return false;
  to->Reset(isolate, value.As<Function>());
  return true;
}

uint32_t ExportIdOf(Isolate *isolate, Local<Context> context, Local<Value> v);

// isExport(value): whether a value is the representative of a native value
// (NI-5), for the bootstrap's structuredClone of native data.
void IsExport(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  info.GetReturnValue().Set(info.Length() > 0 &&
                            ExportIdOf(isolate, isolate->GetCurrentContext(), info[0]) != 0);
}

char *Start(const ScrNodeBridgeHost *host, const char *bootstrap, const char *argv0,
            uintptr_t stack_limit) {
  if (g_setup) return nullptr;
  g_host = host;
  // Native addons resolve napi_* and node::* in the global scope: promote
  // libnode, a dependency of this library, to RTLD_GLOBAL.
  Dl_info info;
  if (dladdr(reinterpret_cast<void *>(&napi_create_function), &info) && info.dli_fname)
    dlopen(info.dli_fname, RTLD_NOW | RTLD_NOLOAD | RTLD_GLOBAL);
  std::vector<std::string> args = {argv0};
  auto result = node::InitializeOncePerProcess(
      args, {node::ProcessInitializationFlags::kNoInitializeV8,
             node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
             node::ProcessInitializationFlags::kNoStdioInitialization,
             node::ProcessInitializationFlags::kNoDefaultSignalHandling,
             node::ProcessInitializationFlags::kNoPrintHelpOrVersionOutput});
  if (result->early_return() || result->exit_code() != 0) {
    std::string message = "Node initialization failed";
    for (const std::string &error : result->errors()) message += ": " + error;
    return Copy(message, nullptr);
  }
  g_platform = node::MultiIsolatePlatform::Create(1);
  v8::V8::InitializePlatform(g_platform.get());
  v8::V8::Initialize();
  g_snapshot = node::EmbedderSnapshotData::BuiltinSnapshotData();
  auto flags = static_cast<node::EnvironmentFlags::Flags>(
      node::EnvironmentFlags::kDefaultFlags | node::EnvironmentFlags::kNoCreateInspector |
      node::EnvironmentFlags::kNoStartDebugSignalHandler);
  std::vector<std::string> errors;
  g_setup = g_snapshot ? node::CommonEnvironmentSetup::CreateFromSnapshot(
                             g_platform.get(), &errors, g_snapshot.get(), result->args(),
                             result->exec_args(), flags)
                       : node::CommonEnvironmentSetup::Create(g_platform.get(), &errors,
                                                              result->args(),
                                                              result->exec_args(), flags);
  if (!g_setup) {
    std::string message = "cannot create the Node environment";
    for (const std::string &error : errors) message += ": " + error;
    return Copy(message, nullptr);
  }
  Isolate *isolate = g_setup->isolate();
  g_locker = new Locker(isolate);
  isolate->Enter();
  // The runtime calls into Node on a dedicated stack of its own
  // (scr_node_island.c), not the thread's: V8's limit follows it, and
  // follows any other stack an entry comes from (StackLimit).
  if (stack_limit != 0) isolate->SetStackLimit(stack_limit);
  g_stack_limit = stack_limit;
  node::SetProcessExitHandler(g_setup->env(),
                              [](node::Environment *, int code) { g_host->exit(code); });
  HandleScope handles(isolate);
  Local<Context> context = g_setup->context();
  Context::Scope context_scope(context);
  Local<Object> global = context->Global();
  Local<Object> native = Object::New(isolate);
  SetMethod(context, native, "settle", Settle);
  SetMethod(context, native, "run", Run);
  SetMethod(context, native, "listen", Listen);
  SetMethod(context, native, "sharedTable", SharedTable);
  SetMethod(context, native, "sharedGet", SharedGet);
  SetMethod(context, native, "sharedTdz", SharedTdz);
  SetMethod(context, native, "isExport", IsExport);
  global->Set(context, Utf8(isolate, "__scriptcNodeIslandHost"), native).Check();
  TryCatch try_catch(isolate);
  if (node::LoadEnvironment(g_setup->env(), bootstrap).IsEmpty()) {
    std::string message = "the Node island bootstrap failed";
    if (try_catch.HasCaught()) {
      Local<Value> stack;
      Local<Value> exception = try_catch.Exception();
      if (exception->IsObject() &&
          exception.As<Object>()->Get(context, Utf8(isolate, "stack")).ToLocal(&stack) &&
          stack->IsString())
        exception = stack;
      message += ": " + ToStdString(isolate, exception);
    } else if (try_catch.HasTerminated()) {
      message += ": execution terminated";
    }
    return Copy(message, nullptr);
  }
  Local<Value> dispatcher;
  if (!global->Get(context, Utf8(isolate, "__scriptcNodeIsland")).ToLocal(&dispatcher) ||
      !dispatcher->IsObject())
    return Copy("the Node island bootstrap left no dispatcher", nullptr);
  Local<Object> d = dispatcher.As<Object>();
  if (!TakeFunction(isolate, context, d, "call", &g_call) ||
      !TakeFunction(isolate, context, d, "setTimer", &g_set_timer) ||
      !TakeFunction(isolate, context, d, "clearTimer", &g_clear_timer) ||
      !TakeFunction(isolate, context, d, "refTimer", &g_ref_timer) ||
      !TakeFunction(isolate, context, d, "refreshTimer", &g_refresh_timer) ||
      !TakeFunction(isolate, context, d, "setImmediate", &g_set_immediate) ||
      !TakeFunction(isolate, context, d, "clearImmediate", &g_clear_immediate) ||
      !TakeFunction(isolate, context, d, "refImmediate", &g_ref_immediate) ||
      !TakeFunction(isolate, context, d, "nextTick", &g_next_tick) ||
      !TakeFunction(isolate, context, d, "emit", &g_emit) ||
      !TakeFunction(isolate, context, d, "load", &g_load) ||
      !TakeFunction(isolate, context, d, "sharedPush", &g_shared_push))
    return Copy("the Node island bootstrap left an incomplete dispatcher", nullptr);
  global->Delete(context, Utf8(isolate, "__scriptcNodeIsland")).FromMaybe(false);
  global->Delete(context, Utf8(isolate, "__scriptcNodeIslandHost")).FromMaybe(false);
  return nullptr;
}

char *Call(uint32_t id, int sync, const char *file, const char *specifier, const char *name,
           const char *args, size_t args_len, size_t *len) {
  Isolate *isolate = g_setup->isolate();
  StackLimit limit(isolate);
  HandleScope handles(isolate);
  Local<Context> context = g_setup->context();
  Context::Scope context_scope(context);
  std::string outcome;
  {
    // No callback scope: the runtime's checkpoint drains what the call
    // queued, at the end of the runtime callback that made it (NI-3).
    TryCatch try_catch(isolate);
    Local<Value> argv[] = {Integer::NewFromUnsigned(isolate, id),
                           v8::Boolean::New(isolate, sync != 0),
                           Utf8(isolate, file),
                           Utf8(isolate, specifier),
                           Utf8(isolate, name),
                           Utf8(isolate, args, args_len)};
    Local<Value> result;
    if (g_call.Get(isolate)
            ->Call(context, v8::Undefined(isolate), sizeof argv / sizeof argv[0], argv)
            .ToLocal(&result)) {
      if (result->IsString()) outcome = ToStdString(isolate, result);
    } else if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
      outcome = ThrownOutcome(isolate, context, try_catch.Exception());
      if (!sync) {
        g_host->settle(id, outcome.data(), outcome.size());
        outcome.clear();
      }
    }
  }
  if (!sync) return nullptr;
  if (outcome.empty()) outcome = "T{\"undefined\":true}";
  return Copy(outcome, len);
}

void Release(void *memory) { std::free(memory); }

// ── the hosted loop ──────────────────────────────────────────────────────

struct Enter {
  Isolate *isolate;
  StackLimit limit;
  HandleScope handles;
  Local<Context> context;
  Context::Scope scope;
  Enter()
      : isolate(g_setup->isolate()), limit(isolate), handles(isolate),
        context(g_setup->context()), scope(context) {}
};

// Calls a bootstrap helper; helpers do not throw, a failure answers empty.
Local<Value> Helper(Enter &e, Global<Function> &fn, int argc, Local<Value> *argv) {
  TryCatch try_catch(e.isolate);
  Local<Value> result;
  if (!fn.Get(e.isolate)->Call(e.context, v8::Undefined(e.isolate), argc, argv).ToLocal(&result))
    return Local<Value>();
  return result;
}

Local<Value> Num(Enter &e, double value) { return v8::Number::New(e.isolate, value); }

uint32_t HelperHandle(Enter &e, Local<Value> result) {
  if (result.IsEmpty()) return 0;
  return result->Uint32Value(e.context).FromMaybe(0);
}

struct PollEntry {
  uv_poll_t handle;
  int fd;
  bool seen;
  bool active;
};

uv_prepare_t g_prepare;
uv_check_t g_check;
uv_idle_t g_idle;
uv_timer_t g_cap;
bool g_hosted = false;
bool g_trace = false; // SCRIPTC_NODE_ISLANDS_TRACE=loop: the I/O state on stderr
bool g_dispatched = false; // the runtime's stations ran this iteration
std::unordered_map<int, PollEntry *> g_polls;

void Dispatch() {
  if (g_dispatched) return;
  g_dispatched = true;
  g_host->io_dispatch();
}

void SyncIo(int phase);

void OnPoll(uv_poll_t *, int, int) {
  Dispatch();
  SyncIo(SCR_NODE_IO_JOBS);
}

void OnIdle(uv_idle_t *) {
  Dispatch();
  SyncIo(SCR_NODE_IO_JOBS);
}

void OnCap(uv_timer_t *) {
  Dispatch();
  SyncIo(SCR_NODE_IO_JOBS);
}

void OnPrepare(uv_prepare_t *) { SyncIo(SCR_NODE_IO_PREPARE); }

// The end of an iteration: the next one may dispatch again (from its idle
// phase when work is ready, else from its poll phase).
void OnCheck(uv_check_t *) {
  g_dispatched = false;
  SyncIo(SCR_NODE_IO_CHECK);
}

void ClosePoll(uv_handle_t *handle) { delete reinterpret_cast<PollEntry *>(handle->data); }

// Mirrors the runtime's I/O state onto the loop: one unref'd poll handle
// per fd, the prepare handle's ref as the runtime's liveness, the idle
// handle while work is ready, the cap timer for work no fd announces. A
// poll handle whose fd leaves the set is stopped, not closed, and started
// again when the fd returns (the worker pool's wake pipe comes and goes
// with every job): libuv cannot watch an fd with a second handle while the
// first is still closing.
void SyncIo(int phase) {
  if (!g_hosted) return;
  ScrNodeIoState state;
  state.phase = phase;
  g_host->io_state(&state);
  if (g_trace) {
    std::fprintf(stderr, "[node-islands] %s alive=%d ready=%d cap=%d fds=",
                 phase == SCR_NODE_IO_CHECK ? "check" : phase == SCR_NODE_IO_JOBS ? "jobs" : "prepare",
                 state.alive, state.ready, state.cap_ms);
    for (int i = 0; i < state.nfds; i++) std::fprintf(stderr, "%s%d", i ? "," : "", state.fds[i]);
    std::fprintf(stderr, "\n");
  }
  uv_loop_t *loop = g_setup->event_loop();
  for (auto &entry : g_polls) entry.second->seen = false;
  for (int i = 0; i < state.nfds; i++) {
    int fd = state.fds[i];
    auto found = g_polls.find(fd);
    PollEntry *entry;
    if (found != g_polls.end()) {
      entry = found->second;
    } else {
      entry = new PollEntry();
      entry->fd = fd;
      entry->active = false;
      if (uv_poll_init(loop, &entry->handle, fd) != 0) {
        delete entry;
        continue;
      }
      entry->handle.data = entry;
      uv_unref(reinterpret_cast<uv_handle_t *>(&entry->handle));
      g_polls.emplace(fd, entry);
    }
    entry->seen = true;
    if (!entry->active && uv_poll_start(&entry->handle, UV_READABLE, OnPoll) == 0)
      entry->active = true;
  }
  for (auto &it : g_polls) {
    if (it.second->seen || !it.second->active) continue;
    uv_poll_stop(&it.second->handle);
    it.second->active = false;
  }
  if (state.alive) uv_ref(reinterpret_cast<uv_handle_t *>(&g_prepare));
  else uv_unref(reinterpret_cast<uv_handle_t *>(&g_prepare));
  if (state.ready) uv_idle_start(&g_idle, OnIdle);
  else uv_idle_stop(&g_idle);
  if (state.cap_ms >= 0) {
    if (!uv_is_active(reinterpret_cast<uv_handle_t *>(&g_cap)))
      uv_timer_start(&g_cap, OnCap, static_cast<uint64_t>(state.cap_ms), 0);
  } else {
    uv_timer_stop(&g_cap);
  }
}

// After every microtask checkpoint, which ends every callback Node
// dispatches (closing-phase ones included): the runtime's rejections, and
// its liveness, which the callback may have changed after the turn's check.
void OnMicrotasksDone(Isolate *, void *) {
  if (!g_hosted) return;
  FlushReleasedExports();
  g_host->microtasks_done();
  SyncIo(SCR_NODE_IO_JOBS);
}

void HostLoop() {
  if (g_hosted) return;
  uv_loop_t *loop = g_setup->event_loop();
  uv_prepare_init(loop, &g_prepare);
  uv_prepare_start(&g_prepare, OnPrepare);
  uv_check_init(loop, &g_check);
  uv_check_start(&g_check, OnCheck);
  uv_unref(reinterpret_cast<uv_handle_t *>(&g_check));
  uv_idle_init(loop, &g_idle);
  uv_unref(reinterpret_cast<uv_handle_t *>(&g_idle));
  uv_timer_init(loop, &g_cap);
  uv_unref(reinterpret_cast<uv_handle_t *>(&g_cap));
  g_setup->isolate()->AddMicrotasksCompletedCallback(OnMicrotasksDone, nullptr);
  const char *trace = std::getenv("SCRIPTC_NODE_ISLANDS_TRACE");
  g_trace = trace != nullptr && std::strcmp(trace, "loop") == 0;
  g_hosted = true;
  SyncIo(SCR_NODE_IO_JOBS);
}

void UnhostLoop() {
  if (!g_hosted) return;
  g_hosted = false;
  g_setup->isolate()->RemoveMicrotasksCompletedCallback(OnMicrotasksDone, nullptr);
  for (auto &entry : g_polls) {
    uv_poll_stop(&entry.second->handle);
    uv_close(reinterpret_cast<uv_handle_t *>(&entry.second->handle), ClosePoll);
  }
  g_polls.clear();
  uv_close(reinterpret_cast<uv_handle_t *>(&g_prepare), nullptr);
  uv_close(reinterpret_cast<uv_handle_t *>(&g_check), nullptr);
  uv_close(reinterpret_cast<uv_handle_t *>(&g_idle), nullptr);
  uv_close(reinterpret_cast<uv_handle_t *>(&g_cap), nullptr);
  uv_run(g_setup->event_loop(), UV_RUN_NOWAIT);
}

void RunMicrotask(void *data) {
  g_host->run(SCR_NODE_JOB_MICROTASK, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(data)));
}

void Microtask(uint32_t token) {
  g_setup->isolate()->EnqueueMicrotask(RunMicrotask,
                                       reinterpret_cast<void *>(static_cast<uintptr_t>(token)));
}

void Tick(uint32_t token) {
  Enter e;
  Local<Value> argv[] = {Num(e, token)};
  Helper(e, g_next_tick, 1, argv);
}

uint32_t Timer(double delay, double repeat, int ref, uint32_t token) {
  Enter e;
  Local<Value> argv[] = {Num(e, delay), Num(e, repeat), v8::Boolean::New(e.isolate, ref != 0),
                         Num(e, token)};
  return HelperHandle(e, Helper(e, g_set_timer, 4, argv));
}

void TimerClear(uint32_t handle) {
  Enter e;
  Local<Value> argv[] = {Num(e, handle)};
  Helper(e, g_clear_timer, 1, argv);
}

void TimerRef(uint32_t handle, int ref) {
  Enter e;
  Local<Value> argv[] = {Num(e, handle), v8::Boolean::New(e.isolate, ref != 0)};
  Helper(e, g_ref_timer, 2, argv);
}

void TimerRefresh(uint32_t handle) {
  Enter e;
  Local<Value> argv[] = {Num(e, handle)};
  Helper(e, g_refresh_timer, 1, argv);
}

uint32_t Immediate(int ref, uint32_t token) {
  Enter e;
  Local<Value> argv[] = {v8::Boolean::New(e.isolate, ref != 0), Num(e, token)};
  return HelperHandle(e, Helper(e, g_set_immediate, 2, argv));
}

void ImmediateClear(uint32_t handle) {
  Enter e;
  Local<Value> argv[] = {Num(e, handle)};
  Helper(e, g_clear_immediate, 1, argv);
}

void ImmediateRef(uint32_t handle, int ref) {
  Enter e;
  Local<Value> argv[] = {Num(e, handle), v8::Boolean::New(e.isolate, ref != 0)};
  Helper(e, g_ref_immediate, 2, argv);
}

// The checkpoint after a runtime macrotask: an empty callback scope, whose
// close runs Node's tick queue and V8's microtasks (InternalCallbackScope::
// Close) unless Node's own dispatch is on the stack, which drains after.
void Checkpoint(int microtasks_first) {
  Enter e;
  if (microtasks_first) e.context->GetMicrotaskQueue()->PerformCheckpoint(e.isolate);
  node::CallbackScope scope(e.isolate, Object::New(e.isolate), node::async_context{0, 0});
}

int RunLoop(int continue_turn) {
  Enter e;
  // The rest of the turn the switch interrupted: libuv's UV_RUN_ONCE skips
  // the leading timers phase and runs poll, check, closing, then timers.
  if (continue_turn) {
    uv_run(g_setup->event_loop(), UV_RUN_ONCE);
    g_platform->DrainTasks(e.isolate);
  }
  return node::SpinEventLoop(g_setup->env()).FromMaybe(0);
}

// An island listener of a process event: through MakeCallback, so a throw
// is an uncaught exception as in Node's own emit.
void Emit(uint32_t event, uint32_t listener, const char *name, int arg) {
  Enter e;
  Local<Value> argv[] = {Num(e, event), Num(e, listener), Utf8(e.isolate, name), Num(e, arg)};
  node::MakeCallback(e.isolate, e.context->Global(), g_emit.Get(e.isolate), 4, argv,
                     node::async_context{0, 0});
}

void Stop() {
  if (!g_setup) return;
  UnhostLoop();
  Isolate *isolate = g_setup->isolate();
  node::Stop(g_setup->env());
  g_call.Reset();
  g_load.Reset();
  DropAllHandles();
  DropAllExports();
  for (Global<Function> *fn :
       {&g_set_timer, &g_clear_timer, &g_ref_timer, &g_refresh_timer, &g_set_immediate,
        &g_clear_immediate, &g_ref_immediate, &g_next_tick, &g_emit, &g_shared_push})
    fn->Reset();
  isolate->Exit();
  delete g_locker;
  g_locker = nullptr;
  g_setup.reset();
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
}


// ── object handles (scope-B NI-4) ───────────────────────────────────────
// The import table: V8 values the runtime holds, one v8::Global per value
// and one id per value while held (found again through the value's
// identity hash), so a V8 object crossing twice is the same runtime
// handle. A typed array's slot also keeps its backing store, so memory the
// runtime aliases stays valid even if JavaScript detaches the buffer.

struct Slot {
  Global<Value> value;
  std::shared_ptr<v8::BackingStore> store;
  int hash = 0;
  bool live = false;
};

std::vector<Slot> g_slots(1); // id 0 is never used
std::vector<uint32_t> g_free_ids;
std::unordered_multimap<int, uint32_t> g_ids;
uint32_t g_live_handles = 0;
// Strings of out-values: valid until the next outermost entry.
std::deque<std::string> g_scratch;
int g_entry_depth = 0;

int IdentityHash(Local<Value> v) {
  if (v->IsObject()) return v.As<Object>()->GetIdentityHash();
  if (v->IsSymbol()) return v.As<v8::Name>()->GetIdentityHash();
  return 0;
}

uint32_t Import(Isolate *isolate, Local<Value> v, std::shared_ptr<v8::BackingStore> store = nullptr) {
  int hash = IdentityHash(v);
  auto range = g_ids.equal_range(hash);
  for (auto it = range.first; it != range.second; ++it) {
    Slot &slot = g_slots[it->second];
    if (slot.value.Get(isolate)->StrictEquals(v)) return it->second;
  }
  uint32_t id;
  if (!g_free_ids.empty()) {
    id = g_free_ids.back();
    g_free_ids.pop_back();
  } else {
    id = static_cast<uint32_t>(g_slots.size());
    g_slots.emplace_back();
  }
  Slot &slot = g_slots[id];
  slot.value.Reset(isolate, v);
  slot.store = std::move(store);
  slot.hash = hash;
  slot.live = true;
  g_ids.emplace(hash, id);
  g_live_handles++;
  return id;
}

Local<Value> HandleValue(Isolate *isolate, uint32_t id) {
  if (id == 0 || id >= g_slots.size() || !g_slots[id].live) return v8::Undefined(isolate);
  return g_slots[id].value.Get(isolate);
}

void Drop(uint32_t id) {
  if (id == 0 || id >= g_slots.size() || !g_slots[id].live) return;
  Slot &slot = g_slots[id];
  auto range = g_ids.equal_range(slot.hash);
  for (auto it = range.first; it != range.second; ++it) {
    if (it->second == id) {
      g_ids.erase(it);
      break;
    }
  }
  slot.value.Reset();
  slot.store.reset();
  slot.live = false;
  g_free_ids.push_back(id);
  g_live_handles--;
}

void DropAllHandles() {
  for (uint32_t id = 1; id < g_slots.size(); id++) Drop(id);
}

uint32_t LiveHandles() { return g_live_handles; }

const char *Scratch(std::string text, size_t *len) {
  g_scratch.push_back(std::move(text));
  *len = g_scratch.back().size();
  return g_scratch.back().data();
}

// WTF-8: V8's UTF-8 writer encodes a lone surrogate as its 3-byte form.
std::string Wtf8(Isolate *isolate, Local<String> s) {
  size_t n = s->Utf8LengthV2(isolate);
  std::string out(n, '\0');
  if (n > 0) s->WriteUtf8V2(isolate, out.data(), n);
  return out;
}

bool HasLoneSurrogate(const char *p, size_t n) {
  for (size_t i = 0; i + 1 < n; i++)
    if (static_cast<unsigned char>(p[i]) == 0xED && static_cast<unsigned char>(p[i + 1]) >= 0xA0)
      return true;
  return false;
}

// A runtime string in V8: NewFromUtf8 would replace lone surrogates, so a
// string that holds one decodes WTF-8 to UTF-16 here.
Local<String> FromWtf8(Isolate *isolate, const char *p, size_t n) {
  if (!HasLoneSurrogate(p, n)) return Utf8(isolate, p, n);
  std::vector<uint16_t> units;
  units.reserve(n);
  for (size_t i = 0; i < n;) {
    unsigned char c = static_cast<unsigned char>(p[i]);
    uint32_t cp;
    size_t k;
    if (c < 0x80) { cp = c; k = 1; }
    else if ((c & 0xE0) == 0xC0 && i + 1 < n) { cp = ((c & 0x1F) << 6) | (p[i + 1] & 0x3F); k = 2; }
    else if ((c & 0xF0) == 0xE0 && i + 2 < n) {
      cp = ((c & 0x0F) << 12) | ((p[i + 1] & 0x3F) << 6) | (p[i + 2] & 0x3F); k = 3;
    } else if ((c & 0xF8) == 0xF0 && i + 3 < n) {
      cp = ((c & 0x07) << 18) | ((p[i + 1] & 0x3F) << 12) | ((p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);
      k = 4;
    } else { cp = 0xFFFD; k = 1; }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units.push_back(static_cast<uint16_t>(0xD800 + (cp >> 10)));
      units.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      units.push_back(static_cast<uint16_t>(cp));
    }
    i += k;
  }
  return String::NewFromTwoByte(isolate, units.data(), NewStringType::kNormal,
                                static_cast<int>(units.size()))
      .ToLocalChecked();
}

// A decimal BigInt text in V8, through 64-bit words.
Local<Value> BigIntFromText(Local<Context> context, const char *p, size_t n) {
  int sign = 0;
  size_t i = 0;
  if (i < n && p[i] == '-') { sign = 1; i++; }
  std::vector<uint64_t> words(1, 0);
  for (; i < n; i++) {
    unsigned __int128 carry = static_cast<unsigned>(p[i] - '0');
    for (uint64_t &w : words) {
      unsigned __int128 v = static_cast<unsigned __int128>(w) * 10 + carry;
      w = static_cast<uint64_t>(v);
      carry = v >> 64;
    }
    if (carry != 0) words.push_back(static_cast<uint64_t>(carry));
  }
  return v8::BigInt::NewFromWords(context, sign, static_cast<int>(words.size()), words.data())
      .ToLocalChecked();
}

uint32_t ElemOf(Local<v8::ArrayBufferView> view) {
  // ScrBytesElem numbering (scr_bytes.h).
  if (view->IsUint8Array()) return 0;
  if (view->IsUint32Array()) return 1;
  if (view->IsFloat32Array()) return 2;
  if (view->IsInt32Array()) return 3;
  if (view->IsFloat64Array()) return 4;
  if (view->IsInt8Array()) return 5;
  if (view->IsUint16Array()) return 6;
  if (view->IsInt16Array()) return 7;
  if (view->IsUint8ClampedArray()) return 8;
  if (view->IsFloat16Array()) return 9;
  return 0; // DataView: bytes
}

size_t ElemSize(uint32_t elem) {
  static const size_t sizes[] = {1, 4, 4, 4, 8, 1, 2, 2, 1, 2};
  return elem < 10 ? sizes[elem] : 1;
}

Local<Value> ToV8(Isolate *isolate, Local<Context> context, const ScrNodeValue *in);
void FromV8(Isolate *isolate, Local<Context> context, Local<Value> v, ScrNodeValue *out);

// ── exports: native values in V8 (scope-B NI-5) ─────────────────────────
// A native value that crosses into Node by reference has an export id in
// the runtime's table and one V8 representative here, held weakly: a
// function whose calls run the native closure (export_call), a promise the
// runtime settles inside its own promise's settlement (export_settle), or
// an object whose property operations all go to the native storage
// (interceptors). The representative carries its id in a private symbol, so
// it crosses back as the native value itself. When V8 collects one, the
// runtime hears export_release at the next microtask checkpoint.

Global<v8::Private> g_export_key;
Global<v8::ObjectTemplate> g_export_template;
std::unordered_map<uint32_t, Global<Object>> g_exports;
std::unordered_map<uint32_t, Global<v8::Promise::Resolver>> g_resolvers;
std::vector<uint32_t> g_released_exports;

Local<v8::Private> ExportKey(Isolate *isolate) {
  if (g_export_key.IsEmpty())
    g_export_key.Reset(isolate, v8::Private::New(isolate, Utf8(isolate, "scriptc:export")));
  return g_export_key.Get(isolate);
}

uint32_t ExportIdOf(Isolate *isolate, Local<Context> context, Local<Value> v) {
  if (!v->IsObject() || v->IsProxy() || g_exports.empty()) return 0;
  Local<Value> id;
  if (!v.As<Object>()->GetPrivate(context, ExportKey(isolate)).ToLocal(&id) || !id->IsUint32())
    return 0;
  return id.As<v8::Uint32>()->Value();
}

void OnExportGone(const v8::WeakCallbackInfo<void> &info) {
  uint32_t id = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(info.GetParameter()));
  auto it = g_exports.find(id);
  if (it != g_exports.end()) {
    it->second.Reset();
    g_exports.erase(it);
  }
  g_released_exports.push_back(id);
}

// Delivers the releases V8's collector queued (never from inside a GC).
void FlushReleasedExports() {
  while (!g_released_exports.empty()) {
    uint32_t id = g_released_exports.back();
    g_released_exports.pop_back();
    if (g_exports.count(id) != 0) continue; // crossed again since
    g_host->export_release(id);
  }
}

uint32_t ExportIdArg(Local<Value> data) {
  return data->IsUint32() ? data.As<v8::Uint32>()->Value() : 0;
}

// Out-value scratch of host calls made from outside any runtime entry (a
// listener Node's loop dispatches) is reset when the call returns.
struct HostCall {
  HostCall() {
    if (g_entry_depth++ == 0) g_scratch.clear();
  }
  ~HostCall() { g_entry_depth--; }
};

void ThrowOrReturn(Isolate *isolate, Local<Context> context, int status, const ScrNodeValue *out,
                   Local<Value> *result) {
  Local<Value> v = ToV8(isolate, context, out);
  if (status == 1) isolate->ThrowException(v);
  else *result = v;
}

void ExportCall(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  uint32_t id = ExportIdArg(info.Data());
  std::vector<ScrNodeValue> args(static_cast<size_t>(info.Length()));
  for (int i = 0; i < info.Length(); i++) FromV8(isolate, context, info[i], &args[i]);
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  int status;
  if (info.IsConstructCall()) {
    // `class Sub extends NativeClass` in island code: the native instance
    // cannot take the island prototype's overrides (NI-6 shortcut).
    auto self = g_exports.find(id);
    if (self != g_exports.end() && !info.NewTarget()->StrictEquals(self->second.Get(isolate))) {
      isolate->ThrowException(v8::Exception::TypeError(Utf8(
          isolate, "scriptc: island code cannot extend a native class of a shared module yet")));
      return;
    }
    status = g_host->export_construct(id, args.data(), args.size(), &out);
  } else {
    ScrNodeValue self;
    FromV8(isolate, context, info.This(), &self);
    status = g_host->export_call(id, &self, args.data(), args.size(), &out);
  }
  Local<Value> result;
  ThrowOrReturn(isolate, context, status, &out, &result);
  if (!result.IsEmpty()) info.GetReturnValue().Set(result);
}

void ExportHasInstance(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue v;
  FromV8(isolate, context, info[0], &v);
  info.GetReturnValue().Set(g_host->export_instance_of(ExportIdArg(info.Data()), &v) == 1);
}

uint32_t HolderId(Local<Object> holder) {
  if (holder->InternalFieldCount() < 1) return 0;
  return ExportIdArg(holder->GetInternalField(0).As<Value>());
}

template <typename T>
uint32_t InfoId(const v8::PropertyCallbackInfo<T> &info) {
  return HolderId(info.HolderV2());
}

void NameKey(Isolate *isolate, Local<Context> context, Local<v8::Name> name, ScrNodeValue *key) {
  FromV8(isolate, context, name, key);
}

void IndexKey(uint32_t index, ScrNodeValue *key) {
  std::memset(key, 0, sizeof *key);
  key->tag = SCR_NV_NUMBER;
  key->u.num = index;
}

v8::Intercepted GetKey(const v8::PropertyCallbackInfo<Value> &info, const ScrNodeValue *key) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  int status = g_host->export_get(InfoId(info), key, &out);
  if (status == 2) return v8::Intercepted::kNo;
  Local<Value> result;
  ThrowOrReturn(isolate, context, status, &out, &result);
  if (!result.IsEmpty()) info.GetReturnValue().Set(result);
  return v8::Intercepted::kYes;
}

v8::Intercepted SetKey(const v8::PropertyCallbackInfo<void> &info, const ScrNodeValue *key,
                       Local<Value> value) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue v, out;
  FromV8(isolate, context, value, &v);
  std::memset(&out, 0, sizeof out);
  int status = g_host->export_set(InfoId(info), key, &v, &out);
  if (status == 2) return v8::Intercepted::kNo;
  if (status == 1) isolate->ThrowException(ToV8(isolate, context, &out));
  return v8::Intercepted::kYes;
}

v8::Intercepted QueryKey(const v8::PropertyCallbackInfo<v8::Integer> &info,
                         const ScrNodeValue *key) {
  HostCall scope;
  if (!g_host->export_has(InfoId(info), key)) return v8::Intercepted::kNo;
  info.GetReturnValue().Set(static_cast<int32_t>(v8::None));
  return v8::Intercepted::kYes;
}

v8::Intercepted DeleteKey(const v8::PropertyCallbackInfo<v8::Boolean> &info,
                          const ScrNodeValue *key) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  int status = g_host->export_delete(InfoId(info), key, &out);
  if (status == 2) return v8::Intercepted::kNo;
  if (status == 1) isolate->ThrowException(ToV8(isolate, context, &out));
  else info.GetReturnValue().Set(true);
  return v8::Intercepted::kYes;
}

v8::Intercepted NamedGet(Local<v8::Name> name, const v8::PropertyCallbackInfo<Value> &info) {
  ScrNodeValue key;
  NameKey(info.GetIsolate(), info.GetIsolate()->GetCurrentContext(), name, &key);
  return GetKey(info, &key);
}
v8::Intercepted NamedSet(Local<v8::Name> name, Local<Value> value,
                         const v8::PropertyCallbackInfo<void> &info) {
  ScrNodeValue key;
  NameKey(info.GetIsolate(), info.GetIsolate()->GetCurrentContext(), name, &key);
  return SetKey(info, &key, value);
}
v8::Intercepted NamedQuery(Local<v8::Name> name, const v8::PropertyCallbackInfo<v8::Integer> &info) {
  ScrNodeValue key;
  NameKey(info.GetIsolate(), info.GetIsolate()->GetCurrentContext(), name, &key);
  return QueryKey(info, &key);
}
v8::Intercepted NamedDelete(Local<v8::Name> name, const v8::PropertyCallbackInfo<v8::Boolean> &info) {
  ScrNodeValue key;
  NameKey(info.GetIsolate(), info.GetIsolate()->GetCurrentContext(), name, &key);
  return DeleteKey(info, &key);
}
v8::Intercepted IndexedGet(uint32_t index, const v8::PropertyCallbackInfo<Value> &info) {
  ScrNodeValue key;
  IndexKey(index, &key);
  return GetKey(info, &key);
}
v8::Intercepted IndexedSet(uint32_t index, Local<Value> value,
                           const v8::PropertyCallbackInfo<void> &info) {
  ScrNodeValue key;
  IndexKey(index, &key);
  return SetKey(info, &key, value);
}
v8::Intercepted IndexedQuery(uint32_t index, const v8::PropertyCallbackInfo<v8::Integer> &info) {
  ScrNodeValue key;
  IndexKey(index, &key);
  return QueryKey(info, &key);
}
v8::Intercepted IndexedDelete(uint32_t index, const v8::PropertyCallbackInfo<v8::Boolean> &info) {
  ScrNodeValue key;
  IndexKey(index, &key);
  return DeleteKey(info, &key);
}

// Own enumerable keys, split for V8: names for the named enumerator, array
// indices for the indexed one.
Local<v8::Array> ExportKeys(const v8::PropertyCallbackInfo<v8::Array> &info, bool indices) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  std::vector<Local<Value>> keep;
  if (g_host->export_keys(InfoId(info), &out) == 0) {
    Local<Value> all = ToV8(isolate, context, &out);
    if (all->IsArray()) {
      Local<v8::Array> list = all.As<v8::Array>();
      for (uint32_t i = 0; i < list->Length(); i++) {
        Local<Value> key = list->Get(context, i).ToLocalChecked();
        uint32_t index = 0;
        bool is_index = false;
        if (key->IsString()) {
          Local<v8::Uint32> as_index;
          if (key->ToArrayIndex(context).ToLocal(&as_index)) {
            is_index = true;
            index = as_index->Value();
          }
        }
        if (is_index != indices) continue;
        keep.push_back(indices ? Local<Value>(v8::Integer::NewFromUnsigned(isolate, index)) : key);
      }
    }
  }
  return v8::Array::New(isolate, keep.data(), keep.size());
}

void NamedEnum(const v8::PropertyCallbackInfo<v8::Array> &info) {
  info.GetReturnValue().Set(ExportKeys(info, false));
}
void IndexedEnum(const v8::PropertyCallbackInfo<v8::Array> &info) {
  info.GetReturnValue().Set(ExportKeys(info, true));
}

Local<v8::ObjectTemplate> ExportTemplate(Isolate *isolate) {
  if (g_export_template.IsEmpty()) {
    Local<v8::ObjectTemplate> t = v8::ObjectTemplate::New(isolate);
    t->SetInternalFieldCount(1);
    t->SetHandler(v8::NamedPropertyHandlerConfiguration(
        NamedGet, NamedSet, NamedQuery, NamedDelete, NamedEnum, Local<Value>(),
        v8::PropertyHandlerFlags::kOnlyInterceptStrings));
    t->SetHandler(v8::IndexedPropertyHandlerConfiguration(IndexedGet, IndexedSet, IndexedQuery,
                                                          IndexedDelete, IndexedEnum));
    g_export_template.Reset(isolate, t);
  }
  return g_export_template.Get(isolate);
}

Local<Value> ExportValue(Isolate *isolate, Local<Context> context, const ScrNodeValue *in) {
  uint32_t id = in->u.exp.id;
  auto found = g_exports.find(id);
  if (found != g_exports.end()) return found->second.Get(isolate);
  Local<Object> obj;
  Local<Value> data = v8::Integer::NewFromUnsigned(isolate, id);
  if (in->flags & SCR_NVF_FUNCTION) {
    Local<Function> fn =
        Function::New(context, ExportCall, data, static_cast<int>(in->u.exp.length))
            .ToLocalChecked();
    fn->SetName(in->u.exp.name != nullptr
                    ? FromWtf8(isolate, in->u.exp.name, in->u.exp.name_len)
                    : String::Empty(isolate));
    if (in->flags & SCR_NVF_CONSTRUCTOR) {
      // A native class: instanceof asks the runtime (NI-6).
      fn->DefineOwnProperty(context, v8::Symbol::GetHasInstance(isolate),
                            Function::New(context, ExportHasInstance, data, 1).ToLocalChecked(),
                            static_cast<v8::PropertyAttribute>(v8::DontEnum | v8::DontDelete |
                                                               v8::ReadOnly))
          .Check();
    }
    obj = fn;
  } else if (in->flags & SCR_NVF_PROMISE) {
    Local<v8::Promise::Resolver> resolver = v8::Promise::Resolver::New(context).ToLocalChecked();
    g_resolvers[id].Reset(isolate, resolver);
    obj = resolver->GetPromise();
  } else {
    obj = ExportTemplate(isolate)->NewInstance(context).ToLocalChecked();
    obj->SetInternalField(0, data);
  }
  obj->SetPrivate(context, ExportKey(isolate), data).Check();
  Global<Object> &slot = g_exports[id];
  slot.Reset(isolate, obj);
  slot.SetWeak(reinterpret_cast<void *>(static_cast<uintptr_t>(id)), OnExportGone,
               v8::WeakCallbackType::kParameter);
  if (in->flags & SCR_NVF_PROMISE) g_host->export_watch(id);
  return obj;
}

void ExportSettle(uint32_t id, int rejected, const ScrNodeValue *value) {
  Enter e;
  auto it = g_resolvers.find(id);
  if (it == g_resolvers.end()) return;
  Local<v8::Promise::Resolver> resolver = it->second.Get(e.isolate);
  it->second.Reset();
  g_resolvers.erase(it);
  Local<Value> v = ToV8(e.isolate, e.context, value);
  if (rejected) resolver->Reject(e.context, v).Check();
  else resolver->Resolve(e.context, v).Check();
}

void DropAllExports() {
  for (auto &it : g_exports) it.second.Reset();
  g_exports.clear();
  for (auto &it : g_resolvers) it.second.Reset();
  g_resolvers.clear();
  g_released_exports.clear();
  g_export_template.Reset();
  g_export_key.Reset();
}

void FromV8(Isolate *isolate, Local<Context> context, Local<Value> v, ScrNodeValue *out) {
  std::memset(out, 0, sizeof *out);
  if (v.IsEmpty() || v->IsUndefined()) { out->tag = SCR_NV_UNDEFINED; return; }
  if (v->IsNull()) { out->tag = SCR_NV_NULL; return; }
  if (v->IsBoolean()) { out->tag = SCR_NV_BOOL; out->u.boolean = v->IsTrue() ? 1 : 0; return; }
  if (v->IsNumber()) { out->tag = SCR_NV_NUMBER; out->u.num = v.As<v8::Number>()->Value(); return; }
  if (v->IsString()) {
    out->tag = SCR_NV_STRING;
    out->u.str.data = Scratch(Wtf8(isolate, v.As<String>()), &out->u.str.len);
    return;
  }
  if (v->IsBigInt()) {
    out->tag = SCR_NV_BIGINT;
    Local<String> text = v->ToString(context).ToLocalChecked();
    out->u.str.data = Scratch(Wtf8(isolate, text), &out->u.str.len);
    return;
  }
  if (v->IsArrayBufferView()) {
    Local<v8::ArrayBufferView> view = v.As<v8::ArrayBufferView>();
    bool dataview = view->IsDataView();
    // Buffer() moves on-heap elements off the heap: the data stays put.
    Local<v8::ArrayBuffer> buffer = view->Buffer();
    std::shared_ptr<v8::BackingStore> store = buffer->GetBackingStore();
    if (!store->IsShared() && !store->IsResizableByUserJavaScript()) {
      uint32_t elem = dataview ? 0 : ElemOf(view);
      out->tag = SCR_NV_BYTES;
      out->u.bytes.elem = elem;
      out->u.bytes.data = static_cast<uint8_t *>(store->Data()) + view->ByteOffset();
      out->u.bytes.len = view->ByteLength() / ElemSize(elem);
      if (node::Buffer::HasInstance(v)) out->flags |= SCR_NVF_BUFFER;
      if (dataview) out->flags |= SCR_NVF_DATAVIEW;
      out->u.bytes.handle = Import(isolate, v, store);
      return;
    }
  }
  if (uint32_t export_id = ExportIdOf(isolate, context, v)) {
    out->tag = SCR_NV_EXPORT;
    out->u.exp.id = export_id;
    return;
  }
  out->tag = SCR_NV_HANDLE;
  uint32_t flags = 0;
  if (v->IsSymbol()) flags |= SCR_NVF_SYMBOL;
  if (v->IsFunction()) {
    flags |= SCR_NVF_FUNCTION;
    if (v.As<Function>()->IsConstructor()) flags |= SCR_NVF_CONSTRUCTOR;
  }
  if (v->IsNativeError()) flags |= SCR_NVF_ERROR;
  if (v->IsArray()) flags |= SCR_NVF_ARRAY;
  if (v->IsPromise()) flags |= SCR_NVF_PROMISE;
  out->flags = flags;
  out->u.handle = Import(isolate, v);
}

void FreeRuntimeBytes(void *, size_t, void *owner) {
  if (owner != nullptr) g_host->bytes_free(owner);
}

Local<Value> ErrorConstructor(Isolate *isolate, Local<Context> context, uint32_t kind) {
  static const char *const names[] = {"Error",          "TypeError", "RangeError", "SyntaxError",
                                      "Error",          "ReferenceError", "EvalError",
                                      "URIError"};
  const char *name = kind < 8 ? names[kind] : "Error";
  return context->Global()->Get(context, Utf8(isolate, name)).ToLocalChecked();
}

Local<Value> ToV8(Isolate *isolate, Local<Context> context, const ScrNodeValue *in) {
  if (in == nullptr) return v8::Undefined(isolate);
  switch (in->tag) {
  case SCR_NV_NULL: return v8::Null(isolate);
  case SCR_NV_BOOL: return v8::Boolean::New(isolate, in->u.boolean != 0);
  case SCR_NV_NUMBER: return v8::Number::New(isolate, in->u.num);
  case SCR_NV_STRING: return FromWtf8(isolate, in->u.str.data, in->u.str.len);
  case SCR_NV_BIGINT: return BigIntFromText(context, in->u.str.data, in->u.str.len);
  case SCR_NV_HANDLE: return HandleValue(isolate, in->u.handle);
  case SCR_NV_BYTES: {
    if (in->u.bytes.handle != 0) return HandleValue(isolate, in->u.bytes.handle);
    size_t elem_size = ElemSize(in->u.bytes.elem);
    size_t byte_len = in->u.bytes.len * elem_size;
    Local<v8::ArrayBuffer> buffer;
    if (byte_len == 0 || in->u.bytes.data == nullptr) {
      buffer = v8::ArrayBuffer::New(isolate, 0);
      if (in->u.bytes.owner != nullptr) g_host->bytes_free(in->u.bytes.owner);
    } else {
      std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(
          in->u.bytes.data, byte_len, FreeRuntimeBytes, in->u.bytes.owner);
      buffer = v8::ArrayBuffer::New(isolate, std::move(store));
    }
    size_t n = in->u.bytes.len;
    if (in->flags & SCR_NVF_DATAVIEW) return v8::DataView::New(buffer, 0, byte_len);
    if (in->flags & SCR_NVF_BUFFER)
      return node::Buffer::New(isolate, buffer, 0, byte_len).ToLocalChecked();
    switch (in->u.bytes.elem) {
    case 1: return v8::Uint32Array::New(buffer, 0, n);
    case 2: return v8::Float32Array::New(buffer, 0, n);
    case 3: return v8::Int32Array::New(buffer, 0, n);
    case 4: return v8::Float64Array::New(buffer, 0, n);
    case 5: return v8::Int8Array::New(buffer, 0, n);
    case 6: return v8::Uint16Array::New(buffer, 0, n);
    case 7: return v8::Int16Array::New(buffer, 0, n);
    case 8: return v8::Uint8ClampedArray::New(buffer, 0, n);
    case 9: return v8::Float16Array::New(buffer, 0, n);
    default: return v8::Uint8Array::New(buffer, 0, n);
    }
  }
  case SCR_NV_ERROR: {
    Local<Value> ctor = ErrorConstructor(isolate, context, in->u.error.kind);
    Local<Value> argv[] = {FromWtf8(isolate, in->u.error.message, in->u.error.message_len)};
    Local<Object> error = ctor.As<Function>()->NewInstance(context, 1, argv).ToLocalChecked();
    std::string name(in->u.error.name, in->u.error.name_len);
    Local<Value> default_name;
    if (!error->Get(context, Utf8(isolate, "name")).ToLocal(&default_name) ||
        ToStdString(isolate, default_name) != name)
      error->Set(context, Utf8(isolate, "name"), FromWtf8(isolate, name.data(), name.size())).Check();
    if (in->u.error.stack != nullptr)
      error->Set(context, Utf8(isolate, "stack"),
                 FromWtf8(isolate, in->u.error.stack, in->u.error.stack_len)).Check();
    if (in->u.error.code != nullptr)
      error->Set(context, Utf8(isolate, "code"),
                 FromWtf8(isolate, in->u.error.code, in->u.error.code_len)).Check();
    return error;
  }
  case SCR_NV_EXPORT: return ExportValue(isolate, context, in);
  case SCR_NV_JSON: {
    Local<Value> parsed;
    if (v8::JSON::Parse(context, FromWtf8(isolate, in->u.str.data, in->u.str.len)).ToLocal(&parsed))
      return parsed;
    return v8::Undefined(isolate);
  }
  default: return v8::Undefined(isolate);
  }
}

// One entry from the runtime: the isolate scope, V8's stack limit for the
// caller's stack, and the out-value scratch (reset by outermost entries).
struct Op {
  Enter e;
  TryCatch try_catch;
  Op() : try_catch(e.isolate) {
    if (g_entry_depth++ == 0) g_scratch.clear();
  }
  ~Op() { g_entry_depth--; }
  // The operation's outcome: 0 and the result, or 1 and the thrown value.
  int Finish(Local<Value> result, bool ok, ScrNodeValue *out) {
    if (ok) {
      FromV8(e.isolate, e.context, result, out);
      return 0;
    }
    if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
      Local<Value> exception = try_catch.Exception();
      try_catch.Reset();
      FromV8(e.isolate, e.context, exception, out);
    } else {
      std::memset(out, 0, sizeof *out);
      out->tag = SCR_NV_UNDEFINED;
    }
    return 1;
  }
  Local<Value> V(const ScrNodeValue *in) { return ToV8(e.isolate, e.context, in); }
};

int Load(const char *path, int esm, ScrNodeValue *out) {
  Op op;
  Local<Value> argv[] = {Utf8(op.e.isolate, path), v8::Boolean::New(op.e.isolate, esm != 0)};
  Local<Value> result;
  bool ok = g_load.Get(op.e.isolate)
                ->Call(op.e.context, v8::Undefined(op.e.isolate), 2, argv)
                .ToLocal(&result);
  return op.Finish(result, ok, out);
}

// The target of a property operation: an object, or a primitive whose
// wrapper answers (ToObject throws for undefined and null).
bool Target(Op &op, uint32_t h, Local<Object> *target) {
  return HandleValue(op.e.isolate, h)->ToObject(op.e.context).ToLocal(target);
}

bool Key(Op &op, const ScrNodeValue *key, Local<Value> *out) {
  Local<Value> k = op.V(key);
  if (k->IsString() || k->IsSymbol() || k->IsNumber()) {
    *out = k;
    return true;
  }
  Local<String> name;
  if (!k->ToString(op.e.context).ToLocal(&name)) return false;
  *out = name;
  return true;
}

int Get(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out) {
  Op op;
  Local<Object> target;
  Local<Value> k, result;
  bool ok = Target(op, h, &target) && Key(op, key, &k) && target->Get(op.e.context, k).ToLocal(&result);
  return op.Finish(result, ok, out);
}

int SetProp(uint32_t h, const ScrNodeValue *key, const ScrNodeValue *value, ScrNodeValue *out) {
  Op op;
  Local<Object> target;
  Local<Value> k;
  bool ok = Target(op, h, &target) && Key(op, key, &k);
  if (ok) {
    v8::Maybe<bool> done = target->Set(op.e.context, k, op.V(value));
    ok = done.IsJust();
    // Strict-mode semantics: a refused assignment throws, as in a module.
    if (ok && !done.FromJust()) {
      op.e.isolate->ThrowException(v8::Exception::TypeError(
          Utf8(op.e.isolate, "Cannot assign to read only property")));
      ok = false;
    }
  }
  return op.Finish(v8::Undefined(op.e.isolate), ok, out);
}

int Has(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out) {
  Op op;
  Local<Value> target = HandleValue(op.e.isolate, h);
  if (!target->IsObject()) {
    op.e.isolate->ThrowException(v8::Exception::TypeError(
        Utf8(op.e.isolate, "Cannot use 'in' operator to search for a key in a primitive")));
    return op.Finish(Local<Value>(), false, out);
  }
  Local<Value> k;
  bool ok = Key(op, key, &k);
  v8::Maybe<bool> found = ok ? target.As<Object>()->Has(op.e.context, k) : v8::Nothing<bool>();
  ok = found.IsJust();
  return op.Finish(v8::Boolean::New(op.e.isolate, ok && found.FromJust()), ok, out);
}

int Del(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out) {
  Op op;
  Local<Object> target;
  Local<Value> k;
  bool ok = Target(op, h, &target) && Key(op, key, &k);
  v8::Maybe<bool> done = ok ? target->Delete(op.e.context, k) : v8::Nothing<bool>();
  ok = done.IsJust();
  if (ok && !done.FromJust()) {
    op.e.isolate->ThrowException(v8::Exception::TypeError(
        Utf8(op.e.isolate, "Cannot delete property")));
    ok = false;
  }
  return op.Finish(v8::Boolean::New(op.e.isolate, ok), ok, out);
}

std::vector<Local<Value>> Args(Op &op, const ScrNodeValue *args, size_t argc) {
  std::vector<Local<Value>> argv;
  argv.reserve(argc);
  for (size_t i = 0; i < argc; i++) argv.push_back(op.V(&args[i]));
  return argv;
}

void NotAFunction(Op &op, const char *what) {
  op.e.isolate->ThrowException(v8::Exception::TypeError(
      Utf8(op.e.isolate, (std::string(what) + " is not a function").c_str())));
}

int Invoke(uint32_t fn, const ScrNodeValue *this_, const ScrNodeValue *args, size_t argc,
           ScrNodeValue *out) {
  Op op;
  Local<Value> callee = HandleValue(op.e.isolate, fn);
  if (!callee->IsFunction()) {
    NotAFunction(op, "value");
    return op.Finish(Local<Value>(), false, out);
  }
  std::vector<Local<Value>> argv = Args(op, args, argc);
  Local<Value> result;
  bool ok = callee.As<Function>()
                ->Call(op.e.context, op.V(this_), static_cast<int>(argv.size()), argv.data())
                .ToLocal(&result);
  return op.Finish(result, ok, out);
}

int InvokeMethod(uint32_t h, const ScrNodeValue *key, const ScrNodeValue *args, size_t argc,
                 ScrNodeValue *out) {
  Op op;
  Local<Value> receiver = HandleValue(op.e.isolate, h);
  Local<Object> target;
  Local<Value> k, callee;
  if (!receiver->ToObject(op.e.context).ToLocal(&target) || !Key(op, key, &k) ||
      !target->Get(op.e.context, k).ToLocal(&callee))
    return op.Finish(Local<Value>(), false, out);
  if (!callee->IsFunction()) {
    std::string what = "property";
    if (k->IsString()) what = ToStdString(op.e.isolate, k);
    NotAFunction(op, what.c_str());
    return op.Finish(Local<Value>(), false, out);
  }
  std::vector<Local<Value>> argv = Args(op, args, argc);
  Local<Value> result;
  bool ok = callee.As<Function>()
                ->Call(op.e.context, receiver, static_cast<int>(argv.size()), argv.data())
                .ToLocal(&result);
  return op.Finish(result, ok, out);
}

int Construct(uint32_t h, const ScrNodeValue *args, size_t argc, ScrNodeValue *out) {
  Op op;
  Local<Value> callee = HandleValue(op.e.isolate, h);
  if (!callee->IsFunction() || !callee.As<Function>()->IsConstructor()) {
    op.e.isolate->ThrowException(v8::Exception::TypeError(
        Utf8(op.e.isolate, "value is not a constructor")));
    return op.Finish(Local<Value>(), false, out);
  }
  std::vector<Local<Value>> argv = Args(op, args, argc);
  Local<Object> result;
  bool ok = callee.As<Function>()
                ->NewInstance(op.e.context, static_cast<int>(argv.size()), argv.data())
                .ToLocal(&result);
  return op.Finish(result, ok, out);
}

int InstanceOf(const ScrNodeValue *value, uint32_t ctor, ScrNodeValue *out) {
  Op op;
  Local<Value> v = op.V(value);
  Local<Value> c = HandleValue(op.e.isolate, ctor);
  if (!c->IsObject()) {
    op.e.isolate->ThrowException(v8::Exception::TypeError(
        Utf8(op.e.isolate, "Right-hand side of 'instanceof' is not callable")));
    return op.Finish(Local<Value>(), false, out);
  }
  v8::Maybe<bool> is = v->InstanceOf(op.e.context, c.As<Object>());
  bool ok = is.IsJust();
  return op.Finish(v8::Boolean::New(op.e.isolate, ok && is.FromJust()), ok, out);
}

int OwnKeys(uint32_t h, int mode, ScrNodeValue *out) {
  Op op;
  Local<Object> target;
  Local<v8::Array> keys;
  bool ok = Target(op, h, &target) &&
            target
                ->GetOwnPropertyNames(
                    op.e.context,
                    mode == 0 ? static_cast<v8::PropertyFilter>(v8::ONLY_ENUMERABLE | v8::SKIP_SYMBOLS)
                              : v8::ALL_PROPERTIES,
                    v8::KeyConversionMode::kConvertToString)
                .ToLocal(&keys);
  return op.Finish(keys, ok, out);
}

void OnSettled(const FunctionCallbackInfo<Value> &info, int rejected) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  uint32_t token = info.Data()->Uint32Value(context).FromMaybe(0);
  ScrNodeValue value;
  FromV8(isolate, context, info[0], &value);
  g_host->settle_value(token, rejected, &value);
}

void OnFulfilled(const FunctionCallbackInfo<Value> &info) { OnSettled(info, 0); }
void OnRejected(const FunctionCallbackInfo<Value> &info) { OnSettled(info, 1); }

// await of a value: PromiseResolve (a native promise is itself) and one
// reaction, as `await` does in JavaScript.
int Then(const ScrNodeValue *value, uint32_t token, ScrNodeValue *out) {
  Op op;
  Local<Value> v = op.V(value);
  Local<v8::Promise> promise;
  if (v->IsPromise()) {
    promise = v.As<v8::Promise>();
  } else {
    Local<v8::Promise::Resolver> resolver;
    if (!v8::Promise::Resolver::New(op.e.context).ToLocal(&resolver) ||
        resolver->Resolve(op.e.context, v).IsNothing())
      return op.Finish(Local<Value>(), false, out);
    promise = resolver->GetPromise();
  }
  Local<Value> data = Integer::NewFromUnsigned(op.e.isolate, token);
  Local<Function> fulfilled, rejected;
  Local<v8::Promise> chained;
  bool ok = Function::New(op.e.context, OnFulfilled, data).ToLocal(&fulfilled) &&
            Function::New(op.e.context, OnRejected, data).ToLocal(&rejected) &&
            promise->Then(op.e.context, fulfilled, rejected).ToLocal(&chained);
  return op.Finish(v8::Undefined(op.e.isolate), ok, out);
}

void ErrorInfo(uint32_t h, ScrNodeErrorInfo *out) {
  Op op;
  std::memset(out, 0, sizeof *out);
  Local<Value> v = HandleValue(op.e.isolate, h);
  if (!v->IsObject()) return;
  Local<Object> error = v.As<Object>();
  static const struct { const char *name; uint32_t kind; } kinds[] = {
      {"TypeError", 1}, {"RangeError", 2}, {"SyntaxError", 3},
      {"ReferenceError", 5}, {"EvalError", 6}, {"URIError", 7}};
  for (const auto &k : kinds) {
    Local<Value> ctor = op.e.context->Global()->Get(op.e.context, Utf8(op.e.isolate, k.name)).ToLocalChecked();
    if (error->InstanceOf(op.e.context, ctor.As<Object>()).FromMaybe(false)) {
      out->kind = k.kind;
      break;
    }
  }
  auto read = [&](const char *key, const char **data, size_t *len, bool optional) {
    Local<Value> value;
    if (!error->Get(op.e.context, Utf8(op.e.isolate, key)).ToLocal(&value)) {
      op.try_catch.Reset();
      return;
    }
    if (optional && !value->IsString()) return;
    Local<String> text;
    if (!value->ToString(op.e.context).ToLocal(&text)) {
      op.try_catch.Reset();
      return;
    }
    *data = Scratch(Wtf8(op.e.isolate, text), len);
  };
  read("name", &out->name, &out->name_len, false);
  read("message", &out->message, &out->message_len, false);
  read("stack", &out->stack, &out->stack_len, true);
  read("code", &out->code, &out->code_len, true);
}

void DropHandle(uint32_t h) {
  if (!g_setup) return;
  Isolate *isolate = g_setup->isolate();
  HandleScope handles(isolate);
  Drop(h);
}

// ── shared modules (NI-6) ──────────────────────────────────────────────
// Natives of the loader hooks (scr_node_island_hooks.cjs): the table of
// modules the program shares, the current value of one export, and the
// exports still in their temporal dead zone.

void SharedTable(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  g_host->shared_table(&out);
  info.GetReturnValue().Set(FromWtf8(isolate, out.u.str.data, out.u.str.len));
}

void SharedTdz(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  g_host->shared_tdz(&out);
  info.GetReturnValue().Set(FromWtf8(isolate, out.u.str.data, out.u.str.len));
}

// sharedGet(mod, slot, mode, tdz): the value, or `tdz` for a binding in its
// temporal dead zone.
void SharedGet(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();
  HostCall scope;
  ScrNodeValue out;
  std::memset(&out, 0, sizeof out);
  int status = g_host->shared_get(Uint32Arg(info, 0), Uint32Arg(info, 1),
                                  static_cast<int>(Uint32Arg(info, 2)), &out);
  if (status == 3) {
    info.GetReturnValue().Set(info[3]);
    return;
  }
  Local<Value> result;
  ThrowOrReturn(isolate, context, status, &out, &result);
  if (!result.IsEmpty()) info.GetReturnValue().Set(result);
}

void SharedPush(uint32_t mod, uint32_t slot, const ScrNodeValue *value) {
  Enter e;
  Local<Value> argv[] = {Integer::NewFromUnsigned(e.isolate, mod),
                         Integer::NewFromUnsigned(e.isolate, slot),
                         ToV8(e.isolate, e.context, value)};
  Helper(e, g_shared_push, 3, argv);
}

const ScrNodeBridge kBridge = {
    SCR_NODE_BRIDGE_ABI,
    NODE_VERSION_STRING,
    NODE_MODULE_VERSION,
    Start,
    Call,
    Release,
    HostLoop,
    Microtask,
    Tick,
    Timer,
    TimerClear,
    TimerRef,
    TimerRefresh,
    Immediate,
    ImmediateClear,
    ImmediateRef,
    Checkpoint,
    RunLoop,
    Emit,
    Stop,
    Load,
    Get,
    SetProp,
    Has,
    Del,
    Invoke,
    InvokeMethod,
    Construct,
    InstanceOf,
    OwnKeys,
    Then,
    ErrorInfo,
    DropHandle,
    LiveHandles,
    ExportSettle,
    SharedPush,
};

}  // namespace

#if defined(__linux__)
// V8 asks v8::base::Stack for the start of the current thread's stack when
// it records the bound of its conservative stack scan (isolate creation,
// Locker). libnode calls these exported functions through its PLT, and this
// library precedes libnode in the lookup scope, so the definitions below
// answer for it: the runtime's stack while the caller runs on it, else
// libnode's own answer (RTLD_NEXT). Without them a garbage collection that
// scans the stack while JavaScript runs on the runtime's stack walks from
// that stack up to the main thread's and faults in the unmapped gap.
// (macOS binds libnode's calls inside libnode; its packs need another way.)
#define SCR_V8_STACK_START(fn, symbol)                                        \
  extern "C" __attribute__((visibility("default"))) void *fn() __asm__(symbol); \
  extern "C" void *fn() {                                                     \
    static void *(*next)() = nullptr;                                         \
    uintptr_t start = HostStackStart();                                       \
    if (start != 0) return reinterpret_cast<void *>(start);                   \
    if (next == nullptr) next = reinterpret_cast<void *(*)()>(dlsym(RTLD_NEXT, symbol)); \
    return next != nullptr ? next() : nullptr;                                \
  }
SCR_V8_STACK_START(ScrV8GetStackStart, "_ZN2v84base5Stack13GetStackStartEv")
SCR_V8_STACK_START(ScrV8GetStackStartUnchecked, "_ZN2v84base5Stack22GetStackStartUncheckedEv")
SCR_V8_STACK_START(ScrV8ObtainCurrentThreadStackStart,
                   "_ZN2v84base5Stack29ObtainCurrentThreadStackStartEv")
#undef SCR_V8_STACK_START
#endif

extern "C" __attribute__((visibility("default"))) const ScrNodeBridge *scr_node_bridge_v1() {
  return &kBridge;
}
