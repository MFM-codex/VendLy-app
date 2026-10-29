#!/bin/bash
# Runs every minute on the server. Pulls new code from GitHub, runs the tests,
# and only restarts the app if they pass. A bad push is rejected, not deployed.
run_tests() {
  if [ -n "$TESTUSER" ] && [ "$(id -u)" = 0 ]; then
    runuser -u "$TESTUSER" -- timeout 120 node --test --no-warnings >/dev/null 2>&1
  else
    timeout 120 node --test --no-warnings >/dev/null 2>&1
  fi
}
main() {
  APP=${APP:-/opt/vendly/app}; STATE=${STATE:-/var/lib/vendly}
  RESTART=${RESTART:-"systemctl restart vendly"}; TESTUSER=${TESTUSER-vendly}
  cd "$APP" || exit 1
  git fetch -q origin main || exit 0
  local L R; L=$(git rev-parse HEAD); R=$(git rev-parse origin/main)
  [ "$L" = "$R" ] && exit 0
  [ "$(cat "$STATE/rejected" 2>/dev/null)" = "$R" ] && exit 0
  git reset -q --hard "$R"
  if (cd server && run_tests); then
    echo "${R:0:7}" > "$STATE/commit"; $RESTART; echo "deployed ${R:0:7}"
  else
    git reset -q --hard "$L"; echo "$R" > "$STATE/rejected"; echo "REJECTED ${R:0:7}: tests failed"
  fi
}
main "$@"; exit $?
