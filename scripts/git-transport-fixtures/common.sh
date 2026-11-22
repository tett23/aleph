# Sourced by the two fixture runners after set -eu.
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  printf 'Usage: %s <path-to-Aleph-Rust-test-binary>\n' "$0" >&2
  exit 2
fi
case "$1" in
  /*) test_binary=$1 ;;
  *) test_binary="$PWD/$1" ;;
esac
git_server_dir=$(git --exec-path)
fixture=$(mktemp -d /tmp/aleph-git-transport.XXXXXX)
fixture_source=$(cd -- "$(dirname -- "$0")" && pwd)
server_pid=
agent_pid=
cleanup() {
  status=$?
  for pid in "$server_pid" "$agent_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ "$status" -ne 0 ] && [ -f "$fixture/server.log" ]; then
    cat "$fixture/server.log" >&2
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
