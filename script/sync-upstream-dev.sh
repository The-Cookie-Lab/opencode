#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: script/sync-upstream-dev.sh [--push] [--no-verify]

Merges upstream/dev into local dev using a merge commit (no-ff).

Options:
  --push       Push origin dev after a successful merge
  --no-verify  When used with --push, bypass pre-push hooks
  -h, --help   Show this help
EOF
}

push_after_merge=false
no_verify=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)
      push_after_merge=true
      shift
      ;;
    --no-verify)
      no_verify=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Not inside a git repository." >&2
  exit 1
fi

cd "$repo_root"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "dev" ]]; then
  echo "Current branch is '$current_branch'. Switch to 'dev' first." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Remote 'upstream' is not configured." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Remote 'origin' is not configured." >&2
  exit 1
fi

echo "Fetching upstream/dev..."
git fetch upstream dev

echo "Merging upstream/dev into dev with --no-ff..."
git merge --no-ff upstream/dev

if [[ "$push_after_merge" == "true" ]]; then
  echo "Pushing dev to origin..."
  if [[ "$no_verify" == "true" ]]; then
    git push --no-verify origin dev
  else
    git push origin dev
  fi
fi

echo "Done."
