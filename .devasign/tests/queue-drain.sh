#!/usr/bin/env bash
# Queue-drain race check for .devasign/hooks/post-commit.
#
# The interleaving that matters is a commit queued in the instant after the runner
# decides the queue is empty but before it gives up. Waiting for that window by
# timing is hopeless, so a stub `ls` creates the marker on the first empty listing
# of the queue: the runner sees an empty queue, and the marker exists by the time
# it looks again. That makes the race deterministic.
#
# Phase 1 asserts the real hook reviews that commit.
# Phase 2 strips the release-and-recheck block and asserts the check FAILS, so the
# test cannot quietly go vacuous if that block is ever removed.
#
# Run: bash .devasign/tests/queue-drain.sh
set -u
HOOKS=$(cd "$(dirname "$0")/../hooks" && pwd)
RACE_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
fails=0

run_case() {
  hook="$1"; want="$2"; label="$3"
  T=$(mktemp -d)
  mkdir -p "$T/bin" "$T/repo/.devasign/hooks"
  cp "$hook" "$T/repo/.devasign/hooks/post-commit"
  chmod +x "$T/repo/.devasign/hooks/post-commit"

  cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in "Review commit "*) echo "${a#Review commit }" >> "$DEVASIGN_TEST_REVIEWED" ;; esac
done
STUB
  cat > "$T/bin/ls" <<'STUB'
#!/usr/bin/env bash
out=$(/bin/ls "$@" 2>/dev/null)
case " $* " in
  *"$DEVASIGN_TEST_QDIR"*)
    # First empty listing of the queue: a commit lands in the drain window.
    if [ -z "$out" ] && [ ! -e "$DEVASIGN_TEST_FIRED" ]; then
      : > "$DEVASIGN_TEST_FIRED"
      : > "$DEVASIGN_TEST_QDIR/9999999999-$DEVASIGN_TEST_RACE_SHA"
    fi
    ;;
esac
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
STUB
  chmod +x "$T/bin/claude" "$T/bin/ls"

  (
    cd "$T/repo" || exit 1
    git init -q . >/dev/null 2>&1
    git config user.email t@example.com; git config user.name t
    echo seed > seed; git add seed; git commit -qm "seed" >/dev/null 2>&1
    root=$(git rev-parse --show-toplevel)
    export DEVASIGN_TEST_REVIEWED="$T/reviewed"
    export DEVASIGN_TEST_QDIR="$root/.devasign/queue"
    export DEVASIGN_TEST_FIRED="$T/fired"
    export DEVASIGN_TEST_RACE_SHA="$RACE_SHA"
    : > "$DEVASIGN_TEST_REVIEWED"
    PATH="$T/bin:$PATH" bash .devasign/hooks/post-commit >/dev/null 2>&1
    for i in $(seq 1 60); do [ -d "$root/.devasign/.review.lock" ] || break; sleep 0.2; done
    sleep 0.5
  )

  got=no; grep -q "$RACE_SHA" "$T/reviewed" 2>/dev/null && got=yes
  if [ "$got" = "$want" ]; then
    echo "  ok    $label (race commit reviewed=$got)"
  else
    echo "  FAIL  $label (race commit reviewed=$got, wanted $want)"
    fails=$((fails + 1))
  fi
  leftover=$(/bin/ls -1 "$T/repo/.devasign/queue" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$want" = yes ]; then
    [ "$leftover" = "0" ] || { echo "  FAIL  $label left $leftover file(s) queued"; fails=$((fails + 1)); }
    [ -d "$T/repo/.devasign/.review.lock" ] && { echo "  FAIL  $label left a stale lock"; fails=$((fails + 1)); }
  fi
  rm -rf "$T"
}

echo "queue-drain race check"
run_case "$HOOKS/post-commit" yes "real hook reviews a commit queued at drain time"

# Mutant: drop the release-and-recheck block, restoring the original bug.
MUT=$(mktemp -d)/post-commit
python3 - "$HOOKS/post-commit" "$MUT" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
a = '      if [ -z "${qfile:-}" ]; then'
b = '      s="${qfile#*-}"'
if a not in s or b not in s:
    sys.exit("drain block not found in post-commit; update queue-drain.sh")
open(dst, "w").write(s[:s.index(a)] + '      [ -n "${qfile:-}" ] || break\n' + s[s.index(b):])
PY
chmod +x "$MUT"
run_case "$MUT" no "mutant without the recheck strands it (proves this test has teeth)"
rm -rf "$(dirname "$MUT")"

if [ "$fails" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($fails)"; exit 1
