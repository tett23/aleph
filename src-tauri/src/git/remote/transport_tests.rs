//! Loopback transport tests. Run each in its own test process so libgit2's
//! temporary SSH home cannot affect other tests. The fixture server may use
//! git-receive-pack and git-upload-pack, and the client runs with an empty PATH.
#![cfg(target_os = "macos")]

use super::*;
use std::{env, ffi::CString, fs, path::Path};

fn isolate_config(path: &Path) {
    let config_dir = path.join("git-config");
    fs::create_dir_all(&config_dir).unwrap();
    // The ignored transport tests run in separate processes.
    for level in [
        git2::ConfigLevel::System,
        git2::ConfigLevel::Global,
        git2::ConfigLevel::XDG,
    ] {
        unsafe { git2::opts::set_search_path(level, &config_dir) }.unwrap();
    }
}

fn initialize_remote(path: &Path) -> Repository {
    let mut options = git2::RepositoryInitOptions::new();
    options.bare(true).external_template(false).no_reinit(true);
    let repo = Repository::init_opts(path, &options).unwrap();
    repo.config()
        .unwrap()
        .set_bool("http.receivepack", true)
        .unwrap();
    repo
}

fn client(path: &Path, url: &str) -> Repository {
    let repo = super::super::initialize(path).unwrap();
    repo.remote("test", url).unwrap();
    let branch = current_branch(&repo).unwrap();
    let name = branch.strip_prefix("refs/heads/").unwrap();
    let mut config = repo.config().unwrap();
    config
        .set_str(&format!("branch.{name}.remote"), "test")
        .unwrap();
    config
        .set_str(&format!("branch.{name}.merge"), "refs/heads/target")
        .unwrap();
    repo
}

fn append(repo: &Repository, body: &str) -> git2::Oid {
    append_file(repo, "chapter.gm", body)
}

fn append_file(repo: &Repository, path: &str, body: &str) -> git2::Oid {
    let sig = git2::Signature::now("Fixture", "fixture@example.test").unwrap();
    let parent = find_head(repo)
        .unwrap()
        .map(|head| head.peel_to_commit().unwrap());
    let previous = parent.as_ref().map(|commit| commit.tree().unwrap());
    let mut tree = repo.treebuilder(previous.as_ref()).unwrap();
    tree.insert(path, repo.blob(body.as_bytes()).unwrap(), 0o100644)
        .unwrap();
    let tree = repo.find_tree(tree.write().unwrap()).unwrap();
    let commit = repo
        .commit(
            Some("HEAD"),
            &sig,
            &sig,
            body,
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .unwrap();
    if !repo.is_bare() {
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }
    commit
}

fn run_roundtrip(
    server: &Repository,
    client: &Repository,
    push_credentials: Option<&Credentials>,
    pull_credentials: impl FnOnce(&Repository) -> Option<Credentials>,
) {
    let initial = find_head(client).unwrap().unwrap().target().unwrap();
    push(client, push_credentials).unwrap();
    assert_eq!(server.refname_to_id("refs/heads/target").unwrap(), initial);

    server.set_head("refs/heads/target").unwrap();
    let incoming = append(server, "第二稿\n");
    let credentials = pull_credentials(client);
    let file = client.workdir().unwrap().join("chapter.gm");
    fs::write(&file, "作業中\n").unwrap();
    assert_eq!(
        pull(client, credentials.as_ref()).unwrap_err().kind,
        ErrorKind::Dirty
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "作業中\n");
    fs::write(&file, "初稿\n").unwrap();
    pull(client, credentials.as_ref()).unwrap();
    assert_eq!(client.head().unwrap().target(), Some(incoming));
    assert_eq!(fs::read_to_string(file).unwrap(), "第二稿\n");
}

#[test]
#[ignore = "requires the loopback SSH fixture and a dedicated test process"]
fn adr0105_a3_i6_i7_ssh_agent_and_host_key() {
    let url = env::var("ALEPH_TEST_SSH_URL").unwrap();
    let bare = env::var("ALEPH_TEST_REMOTE_REPO").unwrap();
    let bare = Path::new(&bare);
    let fixture = bare.parent().unwrap();
    isolate_config(fixture);
    let dir = fixture.join("ssh-home");
    let ssh = dir.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    let path = CString::new(dir.as_os_str().as_encoded_bytes()).unwrap();
    let _config = git2::Config::new().unwrap();
    // This test must run alone and exits without sharing libgit2's global state.
    assert_eq!(
        unsafe {
            libgit2_sys::git_libgit2_opts(libgit2_sys::GIT_OPT_SET_HOMEDIR as _, path.as_ptr())
        },
        0
    );

    let server = initialize_remote(bare);
    let client = client(&fixture.join("client"), &url);
    append(&client, "初稿\n");

    assert_eq!(
        push(&client, None).unwrap_err().kind,
        ErrorKind::Certificate
    );
    fs::write(
        ssh.join("known_hosts"),
        env::var("ALEPH_TEST_WRONG_KNOWN_HOST").unwrap() + "\n",
    )
    .unwrap();
    assert_eq!(
        push(&client, None).unwrap_err().kind,
        ErrorKind::Certificate
    );
    assert!(server.find_reference("refs/heads/target").is_err());

    fs::write(
        ssh.join("known_hosts"),
        env::var("ALEPH_TEST_KNOWN_HOST").unwrap() + "\n",
    )
    .unwrap();
    run_roundtrip(&server, &client, None, |_| None);
}

fn https_credentials(error: Error, password: &str) -> Credentials {
    assert_eq!(error.kind, ErrorKind::AuthRequired);
    Credentials {
        username: "aleph-fixture".to_owned(),
        password: password.to_owned(),
        target: error.auth_target.unwrap(),
    }
}

#[test]
#[ignore = "requires the loopback HTTPS fixture with an untrusted certificate"]
fn adr0105_i6_https_untrusted_certificate() {
    let url = env::var("ALEPH_TEST_HTTPS_URL").unwrap();
    let bare = env::var("ALEPH_TEST_REMOTE_REPO").unwrap();
    let bare = Path::new(&bare);
    let fixture = bare.parent().unwrap();
    isolate_config(fixture);
    let server = initialize_remote(bare);
    let client = client(&fixture.join("certificate-client"), &url);
    append(&client, "初稿\n");
    assert_eq!(
        push(&client, None).unwrap_err().kind,
        ErrorKind::Certificate
    );
    assert!(server.find_reference("refs/heads/target").is_err());
}

#[test]
#[ignore = "requires the loopback HTTPS fixture with a trusted certificate"]
fn adr0105_a3_i6_i7_https_credentials_and_rejected_push() {
    const PASSWORD: &str = "loopback-only-fixture-token";
    let url = env::var("ALEPH_TEST_HTTPS_URL").unwrap();
    let bare = env::var("ALEPH_TEST_REMOTE_REPO").unwrap();
    let bare = Path::new(&bare);
    let fixture = bare.parent().unwrap();
    isolate_config(fixture);
    let server = initialize_remote(bare);
    let client = client(&fixture.join("client"), &url);
    append(&client, "初稿\n");

    // Cancelling the UI prompt means no request with credentials follows.
    let missing = push(&client, None).unwrap_err();
    assert_eq!(missing.kind, ErrorKind::AuthRequired);
    assert!(server.find_reference("refs/heads/target").is_err());
    let wrong = https_credentials(missing, "incorrect-fixture-token");
    let failed = push(&client, Some(&wrong)).unwrap_err();
    assert_eq!(failed.kind, ErrorKind::Authentication);
    assert!(!serde_json::to_string(&failed)
        .unwrap()
        .contains(&wrong.password));
    assert!(server.find_reference("refs/heads/target").is_err());

    let credentials = https_credentials(push(&client, None).unwrap_err(), PASSWORD);
    run_roundtrip(&server, &client, Some(&credentials), |client| {
        Some(https_credentials(pull(client, None).unwrap_err(), PASSWORD))
    });
    let common = client.head().unwrap().target().unwrap();
    let hook = server.path().join("hooks/pre-receive");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let ours = append_file(&client, "local.gm", "ローカル\n");
    let rejected = push(&client, Some(&credentials)).unwrap_err();
    assert_eq!(rejected.message, "リモートが push を拒否しました");
    assert_eq!(server.refname_to_id("refs/heads/target").unwrap(), common);
    fs::remove_file(hook).unwrap();

    let theirs = append_file(&server, "remote.gm", "リモート\n");
    assert_eq!(
        push(&client, Some(&credentials)).unwrap_err().kind,
        ErrorKind::Invalid
    );
    assert_eq!(server.refname_to_id("refs/heads/target").unwrap(), theirs);
    let mut config = client.config().unwrap();
    config.set_str("user.name", "Fixture").unwrap();
    config
        .set_str("user.email", "fixture@example.test")
        .unwrap();
    let pull_credentials = https_credentials(pull(&client, None).unwrap_err(), PASSWORD);
    pull(&client, Some(&pull_credentials)).unwrap();
    let merged = client.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(merged.parent_ids().collect::<Vec<_>>(), [ours, theirs]);

    append(&client, "ローカルの第三稿\n");
    append(&server, "リモートの第三稿\n");
    let before = client.head().unwrap().target();
    assert_eq!(
        pull(&client, Some(&pull_credentials)).unwrap_err().kind,
        ErrorKind::Conflict
    );
    assert_eq!(client.head().unwrap().target(), before);
    assert!(client.index().unwrap().has_conflicts());
    assert_eq!(client.state(), RepositoryState::Merge);
    assert!(!fs::read_to_string(client.path().join("config"))
        .unwrap()
        .contains(PASSWORD));
}
