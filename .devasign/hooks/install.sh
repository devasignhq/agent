#!/usr/bin/env bash
# Installs the DevAsign git hooks, chaining onto any hooks you already have
# (husky, lefthook, hand-written) instead of replacing them.
set -eu
ROOT=$(git rev-parse --show-toplevel)
DST=$(git rev-parse --git-path hooks)
mkdir -p "$DST"
for h in post-commit pre-push; do
  chmod +x "$ROOT/.devasign/hooks/$h"
  target="$DST/$h"
  if [ ! -e "$target" ]; then
    printf '#!/usr/bin/env bash\n"$(git rev-parse --show-toplevel)/.devasign/hooks/%s" "$@"\n' "$h" > "$target"
  elif ! grep -q "devasign/hooks/$h" "$target"; then
    printf '\n# devasign review\n"$(git rev-parse --show-toplevel)/.devasign/hooks/%s" "$@" || exit $?\n' "$h" >> "$target"
  fi
  chmod +x "$target"
done
echo "devasign hooks installed: post-commit (background review) + pre-push (blocking gate)."
echo "Bypass a single commit or push with DEVASIGN_SKIP=1, or 'git push --no-verify'."
