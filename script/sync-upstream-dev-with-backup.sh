#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: script/sync-upstream-dev-with-backup.sh [--push] [--no-verify]

Creates a timestamped backup branch, prunes older backups, and then merges
upstream/dev into local dev using a merge commit (no-ff).

Options:
  --push       Push origin dev after a successful merge
  --no-verify  When used with --push, bypass pre-push hooks
  -h, --help   Show this help
EOF
}

push_after_merge=false
no_verify=false
backup_prefix="backup/dev-pre-upstream-merge-"

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

mapfile -t existing_backups < <(git for-each-ref --format='%(refname:short)' "refs/heads/${backup_prefix}*")
new_backup="${backup_prefix}$(date +%Y%m%d-%H%M%S)"

echo "Creating backup branch: ${new_backup}"
git branch "$new_backup"

# Grace/safety check: never delete old backups unless the new backup is confirmed.
if ! git show-ref --verify --quiet "refs/heads/${new_backup}"; then
  echo "Failed to verify newly created backup branch '${new_backup}'." >&2
  echo "Skipping backup cleanup and aborting sync for safety." >&2
  exit 1
fi

for backup in "${existing_backups[@]}"; do
  if [[ "$backup" == "$new_backup" ]]; then
    continue
  fi
  echo "Removing older backup branch: ${backup}"
  git branch -D "$backup"
done

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

echo "Done. Active backup: ${new_backup}"
