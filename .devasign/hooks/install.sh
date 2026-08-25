#!/usr/bin/env bash
# Installs the DevAsign pre-push hook, chaining onto any hooks you already have
# (husky, lefthook, hand-written) instead of replacing them.
set -eu
ROOT=$(git rev-parse --show-toplevel)
DST=$(git rev-parse --git-path hooks)
mkdir -p "$DST"
# Reviews moved to pre-push only; retire the per-commit hook an older install left.
if [ -e "$DST/post-commit" ] && grep -q "devasign/hooks/post-commit" "$DST/post-commit" 2>/dev/null; then
  if [ "$(wc -l < "$DST/post-commit")" -le 2 ]; then
    rm -f "$DST/post-commit"
    echo "devasign: removed the old post-commit review hook (reviews now run at pre-push)."
  else
    echo "devasign: WARNING - $DST/post-commit still calls the removed devasign post-commit hook."
    echo "devasign:          Delete that line by hand; every commit will otherwise print an error."
  fi
fi
for h in pre-push; do
  chmod +x "$ROOT/.devasign/hooks/$h"
  target="$DST/$h"
  if [ ! -e "$target" ]; then
    printf '#!/usr/bin/env bash\n"$(git rev-parse --show-toplevel)/.devasign/hooks/%s" "$@"\n' "$h" > "$target"
  elif ! grep -q "devasign/hooks/$h" "$target"; then
    printf '\n# devasign review\n"$(git rev-parse --show-toplevel)/.devasign/hooks/%s" "$@" || exit $?\n' "$h" >> "$target"
    # Appending is only useful if control reaches the end of the existing hook.
    # Unindented only: an exit nested in an if or case is not the end of the script.
    if grep -qE '^exit([[:space:]]|$)' "$target"; then
      echo "devasign: WARNING - $target has a top-level 'exit'; the line just appended may never run."
      echo "devasign:          Move that line above the exit, or reviews will silently not happen."
    fi
  fi
  chmod +x "$target"
done
echo "devasign hook installed: pre-push (blocking review gate)."
echo "Bypass a single push with DEVASIGN_SKIP=1, or 'git push --no-verify'."
