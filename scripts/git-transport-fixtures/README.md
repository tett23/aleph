# Git transport tests on macOS

Use these fixtures to exercise Aleph's embedded Git client against local SSH and HTTPS servers for [ADR 0105](../../docs/adr/0105-use-libgit2-without-git-executable.md).
Each runner starts its server on `127.0.0.1`, creates temporary keys or certificates, and runs the ignored Rust tests in dedicated processes with a `PATH` containing no executables.
The Rust tests create both repositories with libgit2.
The fixture servers use Git's `git-upload-pack`, `git-receive-pack`, and `git-http-backend` to serve those repositories.

## Run the tests

Use the macOS development toolchain, with Git on the runner's `PATH` and Ruby with WEBrick and OpenSSL.
The SSH runner needs OpenSSH to run an unprivileged server as the current user and start a dedicated agent.
The HTTPS runner uses Clang and the macOS Security framework to configure a process-local trust anchor.

Build the Rust test executable from the repository root.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run
```

Replace `<test-executable>` with the path printed in the `Executable unittests` line.

```sh
sh scripts/git-transport-fixtures/run-ssh.sh '<test-executable>'
sh scripts/git-transport-fixtures/run-https.sh '<test-executable>'
```

The SSH runner checks unknown and mismatched host keys before installing the fixture host key in libgit2's isolated `known_hosts` directory.
It then checks push and pull with the dedicated SSH agent.
The HTTPS runner first checks rejection under macOS's normal trust evaluation.
For the authentication and integration test, it supplies the fixture certificate as the trust anchor only in that test process and Secure Transport still evaluates the certificate and hostname.
The runners leave the user's SSH agent, Git configuration, and keychain untouched.
