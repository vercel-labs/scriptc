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
#include <node_api.h>
#include <node_version.h>
#include <uv.h>
#include <v8.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
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
std::unique_ptr<node::MultiIsolatePlatform> g_platform;
node::EmbedderSnapshotData::Pointer g_snapshot;
std::unique_ptr<node::CommonEnvironmentSetup> g_setup;
Locker *g_locker = nullptr;
Global<Function> g_call;
// The bootstrap's hosted-loop helpers (scr_node_island_host.cjs).
Global<Function> g_set_timer, g_clear_timer, g_ref_timer, g_refresh_timer;
Global<Function> g_set_immediate, g_clear_immediate, g_ref_immediate;
Global<Function> g_next_tick, g_emit;

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
      !TakeFunction(isolate, context, d, "emit", &g_emit))
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
  for (Global<Function> *fn :
       {&g_set_timer, &g_clear_timer, &g_ref_timer, &g_refresh_timer, &g_set_immediate,
        &g_clear_immediate, &g_ref_immediate, &g_next_tick, &g_emit})
    fn->Reset();
  isolate->Exit();
  delete g_locker;
  g_locker = nullptr;
  g_setup.reset();
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
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
