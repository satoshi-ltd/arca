#!/usr/bin/env bash
set -uo pipefail
: "${TAG:?}" "${RELEASE_SHA:?}" "${GITHUB_REPOSITORY:?}"
delay="${RECORD_RETRY_DELAY:-10}"
for attempt in 1 2 3 4; do
  if output=$(gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$TAG" -f sha="$RELEASE_SHA" 2>&1); then
    echo "Recorded $TAG"
    exit 0
  fi
  if grep -q "Reference already exists" <<<"$output"; then
    echo "$TAG already exists"
    exit 0
  fi
  echo "Attempt $attempt to record $TAG failed: $output"
  [ "$attempt" -lt 4 ] && sleep $((attempt * delay))
done
echo "::error::The image is published but $TAG was not recorded. Run: gh api repos/$GITHUB_REPOSITORY/git/refs -f ref=refs/tags/$TAG -f sha=$RELEASE_SHA"
exit 1
