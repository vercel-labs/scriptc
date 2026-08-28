/* Deterministic regression for util.inspect's thread-instanced circular
 * target map. The inspect stack and target count were already TLS; the
 * target pointer array must be TLS too. Thread A records its first target,
 * thread B then records a different target in its own slot zero, and A
 * must still resolve its target as circular id 1. A shared backing array
 * makes A lose that entry and assign id 2 instead. */
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

extern void scr_insp_seen_push(const void *v);
extern double scr_insp_circ_check(const void *v);

/* The retained inspect sections only need the OOM trap path. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int stage;
static int targets[2];
static double ids[3];

static void advance(int next) {
  pthread_mutex_lock(&mu);
  stage = next;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static void await(int expected) {
  pthread_mutex_lock(&mu);
  while (stage < expected) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static void *worker_a(void *unused) {
  (void)unused;
  scr_insp_seen_push(&targets[0]);
  ids[0] = scr_insp_circ_check(&targets[0]);
  advance(1);
  await(2);
  ids[2] = scr_insp_circ_check(&targets[0]);
  return NULL;
}

static void *worker_b(void *unused) {
  (void)unused;
  await(1);
  scr_insp_seen_push(&targets[1]);
  ids[1] = scr_insp_circ_check(&targets[1]);
  advance(2);
  return NULL;
}

int main(void) {
  pthread_t a, b;
  pthread_create(&a, NULL, worker_a, NULL);
  pthread_create(&b, NULL, worker_b, NULL);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  printf("%.0f %.0f %.0f\n", ids[0], ids[1], ids[2]);
  return ids[0] == 1 && ids[1] == 1 && ids[2] == 1 ? 0 : 1;
}
