#!/usr/bin/env bash
# Stale-lock handling for .devasign/hooks/post-commit.
#
# A runner that was killed or has hung must not disable reviews forever, and a
# runner that is working must not have its lock stolen out from under it. The
# difference between the two is progress, so the runner touches the lock before
# each review and staleness is measured against that heartbeat.
#
# Run: bash .devasign/tests/stale-lock.sh
set -u
HOOKS=$(cd "$(dirname "$0")/../hooks" && pwd)
fails=0
T=""; ROOT=""; HUNG=""

setup() {   # $1 = seconds the stub review takes
  T=$(mktemp -d); mkdir -p "$T/bin" "$T/repo/.devasign/hooks"
  cp "$HOOKS/post-commit" "$T/repo/.devasign/hooks/post-commit"
  chmod +x "$T/repo/.devasign/hooks/post-commit"
  printf '#!/usr/bin/env bash\nsleep %s\n' "$1" > "$T/bin/claude"; chmod +x "$T/bin/claude"
  (
    cd "$T/repo" || exit 1
    git init -q .; git config user.email t@example.com; git config user.name t
    echo a > a; git add a; git commit -qm one
  ) >/dev/null 2>&1
  ROOT=$(cd "$T/repo" && git rev-parse --show-toplevel)
  mkdir -p "$ROOT/.devasign"
}
teardown() { [ -n "$HUNG" ] && { kill "$HUNG" 2>/dev/null; wait "$HUNG" 2>/dev/null; }; HUNG=""; rm -rf "$T"; }
run_hook() { ( cd "$T/repo" && PATH="$T/bin:$PATH" bash .devasign/hooks/post-commit 2>&1 ); }
expect() {  # label, wanted substring, actual
  case "$3" in
    *"$2"*) echo "  ok    $1" ;;
    *)      echo "  FAIL  $1: wanted '$2', got '$3'"; fails=$((fails + 1)) ;;
  esac
}

echo "stale-lock checks"

# A runner that hung: its pid stays alive forever, so liveness alone never frees the lock.
setup 600
mkdir "$ROOT/.devasign/.review.lock"
sleep 600 & HUNG=$!
echo "$HUNG" > "$ROOT/.devasign/.review.lock.pid"
touch -t 202001010000 "$ROOT/.devasign/.review.lock"     # no heartbeat since 2020
expect "hung runner (live pid, no heartbeat) is reclaimed" "reclaimed a stale review lock" "$(run_hook)"
teardown

# The same live pid, but the lock is fresh: work is in progress, leave it alone.
setup 600
mkdir "$ROOT/.devasign/.review.lock"
sleep 600 & HUNG=$!
echo "$HUNG" > "$ROOT/.devasign/.review.lock.pid"
expect "working runner (live pid, fresh heartbeat) keeps its lock" "queued for review" "$(run_hook)"
teardown

# A killed runner: pid gone, lock left behind.
setup 1
mkdir "$ROOT/.devasign/.review.lock"
echo 999999 > "$ROOT/.devasign/.review.lock.pid"
expect "killed runner (dead pid) is reclaimed" "reclaimed a stale review lock" "$(run_hook)"
teardown

# The heartbeat has to actually beat, or a long backlog would look hung.
setup 3
head=$(cd "$T/repo" && git rev-parse HEAD)
mkdir -p "$ROOT/.devasign/queue"
for n in 1 2 3; do : > "$ROOT/.devasign/queue/100$n-$head"; done
run_hook >/dev/null 2>&1
sleep 1
m1=$(stat -f %m "$ROOT/.devasign/.review.lock" 2>/dev/null || echo none)
sleep 5
if [ -d "$ROOT/.devasign/.review.lock" ]; then
  m2=$(stat -f %m "$ROOT/.devasign/.review.lock" 2>/dev/null || echo none)
  if [ "$m1" != "$m2" ]; then echo "  ok    heartbeat advances while the queue drains"
  else echo "  FAIL  heartbeat never advanced ($m1 == $m2)"; fails=$((fails + 1)); fi
else
  echo "  FAIL  drain finished before the heartbeat could be observed"; fails=$((fails + 1))
fi
pkill -f "sleep 3" 2>/dev/null
teardown

if [ "$fails" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($fails)"; exit 1
