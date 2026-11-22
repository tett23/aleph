#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"
port=$(/usr/bin/ruby -rsocket -e 'puts TCPServer.new("127.0.0.1",0).addr[1]')
for key in host wrong client-key; do
  /usr/bin/ssh-keygen -q -t ed25519 -N "" -f "$fixture/$key"
done
cp "$fixture/client-key.pub" "$fixture/authorized_keys"
cat > "$fixture/command.sh" <<END
#!/bin/sh
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
case "\$SSH_ORIGINAL_COMMAND" in
  "git-upload-pack '$fixture/remote.git'") exec "$git_server_dir/git-upload-pack" "$fixture/remote.git" ;;
  "git-receive-pack '$fixture/remote.git'") exec "$git_server_dir/git-receive-pack" "$fixture/remote.git" ;;
  *) printf 'Unexpected remote command: %s\n' "\$SSH_ORIGINAL_COMMAND" >&2; exit 1 ;;
esac
END
chmod 700 "$fixture/command.sh"
cat > "$fixture/sshd_config" <<END
ListenAddress 127.0.0.1
Port $port
HostKey $fixture/host
PidFile $fixture/sshd.pid
AuthorizedKeysFile $fixture/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitRootLogin no
DisableForwarding yes
PermitTTY no
AllowUsers $(/usr/bin/id -un)
ForceCommand $fixture/command.sh
LogLevel VERBOSE
END
/usr/sbin/sshd -D -e -f "$fixture/sshd_config" > "$fixture/server.log" 2>&1 &
server_pid=$!
/usr/bin/ssh-agent -D -a "$fixture/agent.sock" > "$fixture/agent.log" 2>&1 &
agent_pid=$!
for i in 1 2 3 4 5; do
  [ -S "$fixture/agent.sock" ] && break
  /bin/sleep 1
done
export SSH_AUTH_SOCK="$fixture/agent.sock"
/usr/bin/ssh-add "$fixture/client-key"
export ALEPH_TEST_REMOTE_REPO="$fixture/remote.git"
export ALEPH_TEST_SSH_URL="ssh://$(/usr/bin/id -un)@127.0.0.1:$port$ALEPH_TEST_REMOTE_REPO"
export ALEPH_TEST_KNOWN_HOST="[127.0.0.1]:$port $(/usr/bin/awk '{print $1,$2}' "$fixture/host.pub")"
export ALEPH_TEST_WRONG_KNOWN_HOST="[127.0.0.1]:$port $(/usr/bin/awk '{print $1,$2}' "$fixture/wrong.pub")"
PATH="$fixture/no-client-tools" "$test_binary" --exact git::remote::transport_tests::adr0105_a3_i6_i7_ssh_agent_and_host_key --ignored --nocapture
