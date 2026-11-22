use super::*;
use crate::fsops::testdir;

#[test]
fn adr0105_a1_i1_i3_repository_lifecycle_requires_identity_before_staging() {
    let dir = testdir::fresh("libgit-lifecycle").canonicalize().unwrap();
    let repo = initialize(&dir).unwrap();
    std::fs::write(dir.join("章.gm"), "最初\n").unwrap();
    assert_eq!(
        head_text(&repo, Path::new("章.gm")).unwrap(),
        HeadText::Unborn
    );
    let empty = git2::Config::new().unwrap();
    let error = commit(&repo, &dir, &empty, "First", false).unwrap_err();
    assert_eq!(error.kind, ErrorKind::IdentityRequired);
    assert!(repo.index().unwrap().is_empty());
    let identity = git2::Config::open(&repo.path().join("test-identity")).unwrap();
    let mut identity = identity;
    identity.set_str("user.name", "Tester").unwrap();
    identity
        .set_str("user.email", "tester@example.test")
        .unwrap();
    let first = commit(&repo, &dir, &identity, "First", false)
        .unwrap()
        .unwrap();
    assert!(!first.id.is_empty());
    assert_eq!(
        head_text(&repo, Path::new("章.gm")).unwrap(),
        HeadText::Text {
            text: "最初\n".into()
        }
    );
    assert_eq!(
        head_text(&repo, Path::new("missing.gm")).unwrap(),
        HeadText::Missing
    );
    assert!(statuses(&repo, &dir).unwrap().is_empty());
}

#[test]
fn adr0105_i2_subdirectory_status_does_not_write_index_or_cross_workspace() {
    let dir = testdir::fresh("libgit-status").canonicalize().unwrap();
    let repo = initialize(&dir).unwrap();
    let workspace = dir.join("right");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("a.gm"), "a").unwrap();
    std::fs::write(dir.join("outside.gm"), "b").unwrap();
    let before = std::fs::read(repo.path().join("index")).ok();
    let list = statuses(&repo, &workspace).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "a.gm");
    assert_eq!(std::fs::read(repo.path().join("index")).ok(), before);
    assert!(repo.head().is_err());
    assert!(literal_path(&workspace, "../outside.gm").is_err());
}

#[test]
fn adr0105_i5_diff_preserves_unicode_and_final_newline() {
    let dir = testdir::fresh("libgit-diff").canonicalize().unwrap();
    let repo = initialize(&dir).unwrap();
    let path = dir.join("a.gm");
    std::fs::write(path, "猫\n𠮷").unwrap();
    let result = diff(&repo, Some(Path::new("a.gm")), None).unwrap();
    assert_eq!(result.body, DiffBody::Lines);
    assert_eq!(result.added, 2);
    let restored = result
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|line| line.text.as_str())
        .collect::<String>();
    assert_eq!(restored, "猫\n𠮷");
}

#[test]
fn adr0105_i1_i3_i4_isolated_git_lifecycle() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let key = "ALEPH_ADR0105_TEST_ROOT";
    let Ok(dir) = std::env::var(key) else {
        let dir = testdir::fresh("embedded-git-no-cli")
            .canonicalize()
            .unwrap();
        let bin = dir.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let fake = bin.join("git");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf started > \"$ALEPH_ADR0105_TEST_ROOT/git-started\"\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        for (index, path) in [
            PathBuf::new(),
            bin,
            std::env::var_os("PATH")
                .map(PathBuf::from)
                .unwrap_or_default(),
        ]
        .into_iter()
        .enumerate()
        {
            let run = dir.join(index.to_string());
            std::fs::create_dir(&run).unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "git::tests::adr0105_i1_i3_i4_isolated_git_lifecycle",
                ])
                .env(key, &run)
                .env("HOME", &run)
                .env("XDG_CONFIG_HOME", run.join("xdg"))
                .env("PATH", path)
                .env("GIT_AUTHOR_NAME", "wrong author")
                .env("GIT_AUTHOR_EMAIL", "wrong@example.test")
                .env("GIT_COMMITTER_NAME", "wrong committer")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(!run.join("git-started").exists());
        }
        return;
    };
    let dir = PathBuf::from(dir);
    let workspace = dir.join("work");
    std::fs::create_dir(&workspace).unwrap();
    let reach = guard::Reach {
        roots: vec![workspace.clone()],
        ..Default::default()
    };
    let run = |op| operate(&reach, &workspace, op);
    assert!(matches!(
        run(Operation::Repository).unwrap(),
        Response::Repository(None)
    ));
    assert!(matches!(
        run(Operation::Head {
            path: "a.gm".into()
        })
        .unwrap(),
        Response::Head(HeadText::NotRepository)
    ));
    assert!(matches!(
        run(Operation::Initialize).unwrap(),
        Response::Repository(Some(_))
    ));
    let config = workspace.join(".git/config");
    let repo = Repository::open(&workspace).unwrap();
    let mut settings = repo.config().unwrap();
    let marker = dir.join("hostile-started");
    let script = workspace.join(".git/hooks/pre-commit");
    std::fs::write(
        &script,
        format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    for key in [
        "core.fsmonitor",
        "diff.external",
        "core.sshCommand",
        "credential.helper",
    ] {
        settings.set_str(key, script.to_str().unwrap()).unwrap();
    }
    std::fs::write(workspace.join("a.gm"), "𠮷\n").unwrap();
    assert!(matches!(
        run(Operation::Commit {
            message: "blocked".into(),
            automatic: true,
            scope: None
        }),
        Err(Error {
            kind: ErrorKind::IdentityRequired,
            ..
        })
    ));
    assert!(!workspace.join(".git/index").exists());

    let target = dir.join(".gitconfig");
    let global = serde_json::to_value(global_identity().unwrap()).unwrap();
    assert_eq!(global["target"], target.to_str().unwrap());
    assert_eq!(global["exists"], false);
    assert!(save_global_identity(
        target.clone(),
        "Created".into(),
        "created@example.test".into()
    )
    .is_ok());
    assert!(target.is_file());

    std::fs::write(
        dir.join("included.gitconfig"),
        "[user]\n\tname = Included\n\temail = included@example.test\n",
    )
    .unwrap();
    std::fs::write(
        &target,
        "[include]\n\tpath = included.gitconfig\n[core]\n\teditor = keep-me\n",
    )
    .unwrap();
    let before = std::fs::read(dir.join("included.gitconfig")).unwrap();
    let saved = serde_json::to_value(
        save_global_identity(
            target.clone(),
            "Author".into(),
            "author@example.test".into(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved["effective"]["name"]["source"],
        target.to_str().unwrap()
    );
    assert_eq!(saved["effective"]["name"]["value"], "Author");
    assert_eq!(
        std::fs::read(dir.join("included.gitconfig")).unwrap(),
        before
    );
    assert_eq!(
        git2::Config::open(&target)
            .unwrap()
            .get_string("core.editor")
            .unwrap(),
        "keep-me"
    );

    let local = || match run(Operation::Identity).unwrap() {
        Response::Identity(Some(identity)) => serde_json::to_value(identity).unwrap(),
        _ => panic!("expected repository identity"),
    };
    assert_eq!(local()["local"]["name"], serde_json::Value::Null);
    assert_eq!(local()["inherited"]["name"]["value"], "Author");
    let save = |name: &str, email: &str| {
        run(Operation::SaveIdentity {
            target: config.clone(),
            name: name.into(),
            email: email.into(),
        })
    };
    std::fs::write(dir.join("xdg-identity"), "[user]\n\tname = Only a name\n").unwrap();
    let prior_global = std::fs::read(&target).unwrap();
    std::fs::write(&target, std::fs::read(dir.join("xdg-identity")).unwrap()).unwrap();
    assert!(save("", "partial@example.test").is_ok());
    assert_eq!(local()["effective"]["name"]["value"], "Only a name");
    assert_eq!(
        local()["effective"]["email"]["value"],
        "partial@example.test"
    );
    std::fs::write(&target, prior_global).unwrap();
    assert!(save("bad\nname", "local@example.test").is_err());
    assert!(save("", "local@example.test").is_ok());
    assert_eq!(local()["effective"]["email"]["value"], "local@example.test");
    assert_eq!(local()["local"]["name"], serde_json::Value::Null);
    let mut lock = config.clone();
    lock.set_extension("lock");
    std::fs::write(&lock, "held").unwrap();
    let prior = std::fs::read(&config).unwrap();
    assert!(save("locked", "locked@example.test").is_err());
    assert_eq!(std::fs::read(&config).unwrap(), prior);
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), "held");
    std::fs::remove_file(lock).unwrap();
    assert!(save("", "").is_ok());
    assert_eq!(
        local()["effective"]["email"]["value"],
        "author@example.test"
    );
    assert_eq!(local()["local"]["email"], serde_json::Value::Null);

    std::fs::write(workspace.join(".gitattributes"), "*.gm filter=external\n").unwrap();
    settings
        .set_str("filter.external.clean", script.to_str().unwrap())
        .unwrap();
    assert!(matches!(
        run(Operation::Commit {
            message: "filter".into(),
            automatic: false,
            scope: None
        }),
        Err(Error {
            kind: ErrorKind::UnsupportedFilter,
            ..
        })
    ));
    assert!(!workspace.join(".git/index").exists());
    std::fs::remove_file(workspace.join(".gitattributes")).unwrap();
    assert!(matches!(
        run(Operation::Commit {
            message: "manual".into(),
            automatic: false,
            scope: None
        })
        .unwrap(),
        Response::Commit(Some(_))
    ));
    let first = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(first.author().name().unwrap(), "Author");
    assert_eq!(first.committer().email().unwrap(), "author@example.test");
    std::fs::write(workspace.join("a.gm"), "猫\n").unwrap();
    assert!(matches!(
        run(Operation::Commit {
            message: "Autosave 2026-11-22".into(),
            automatic: true,
            scope: None
        })
        .unwrap(),
        Response::Commit(Some(_))
    ));
    assert!(
        matches!(run(Operation::History).unwrap(), Response::History(entries) if entries.len() == 2)
    );
    assert!(
        matches!(run(Operation::Status).unwrap(), Response::Status(entries) if entries.is_empty())
    );
    assert!(!marker.exists());
}

#[test]
fn adr0105_i2_i4_linked_worktree_shares_identity_and_dropped_paths_are_read_only() {
    let dir = testdir::fresh("embedded-git-linked")
        .canonicalize()
        .unwrap();
    let main = dir.join("main");
    let linked = dir.join("linked");
    std::fs::create_dir(&main).unwrap();
    let repo = initialize(&main).unwrap();
    let identity = repo.config().unwrap();
    let mut identity = identity;
    identity.set_str("user.name", "Worktree").unwrap();
    identity
        .set_str("user.email", "linked@example.test")
        .unwrap();
    std::fs::write(main.join("a.gm"), "text\n").unwrap();
    commit(&repo, &main, &identity, "Base", false).unwrap();
    repo.worktree("linked", &linked, None).unwrap();
    let reach = guard::Reach {
        dropped: vec![linked.clone()],
        ..Default::default()
    };
    let linked_repo = Repository::open(&linked).unwrap();
    let target = repo.path().canonicalize().unwrap().join("config");
    assert!(
        matches!(operate(&reach, &linked, Operation::Repository).unwrap(), Response::Repository(Some(info)) if info.linked)
    );
    assert!(matches!(
        operate(
            &reach,
            &linked,
            Operation::SaveIdentity {
                target: target.clone(),
                name: "Changed".into(),
                email: "linked@example.test".into()
            }
        ),
        Err(Error {
            kind: ErrorKind::Invalid,
            ..
        })
    ));
    let view = repository_info(&linked_repo).unwrap();
    assert_eq!(view.root.as_os_str(), linked.as_os_str());
    assert_eq!(
        view.git_dir.as_os_str(),
        linked_repo.path().canonicalize().unwrap().as_os_str()
    );
    let info = serde_json::to_value(identity::local(&linked_repo).unwrap()).unwrap();
    assert_eq!(info["target"], target.to_str().unwrap());
    assert_eq!(info["effective"]["name"]["value"], "Worktree");
}

#[test]
fn adr0105_i5_named_binary_deleted_and_renamed_files_keep_their_kind() {
    let dir = testdir::fresh("embedded-git-diff-kinds")
        .canonicalize()
        .unwrap();
    let repo = initialize(&dir).unwrap();
    let mut identity = repo.config().unwrap();
    identity.set_str("user.name", "Diff").unwrap();
    identity.set_str("user.email", "diff@example.test").unwrap();
    std::fs::write(dir.join("旧.gm"), "原稿\n").unwrap();
    std::fs::write(dir.join("削除.gm"), "削除\n").unwrap();
    commit(&repo, &dir, &identity, "Base", false).unwrap();
    std::fs::rename(dir.join("旧.gm"), dir.join("新.gm")).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("旧.gm")).unwrap();
    index.add_path(Path::new("新.gm")).unwrap();
    index.write().unwrap();
    std::fs::remove_file(dir.join("削除.gm")).unwrap();
    std::fs::write(dir.join("binary.bin"), [0, 0xff, 0xbb, 0]).unwrap();
    let entries = statuses(&repo, &dir).unwrap();
    let renamed = entries.iter().find(|entry| entry.path == "新.gm").unwrap();
    assert_eq!(renamed.xy, "R ");
    assert_eq!(renamed.from.as_deref(), Some("旧.gm"));
    let deleted = diff(&repo, Some(Path::new("削除.gm")), None).unwrap();
    assert_eq!(deleted.removed, 1);
    assert_eq!(deleted.hunks[0].lines[0].text, "削除\n");
    let rename = diff(&repo, Some(Path::new("新.gm")), Some(Path::new("旧.gm"))).unwrap();
    assert_eq!(rename.body, DiffBody::Empty);
    let binary = diff(&repo, Some(Path::new("binary.bin")), None).unwrap();
    assert_eq!(binary.body, DiffBody::Binary);
}

#[test]
fn adr0105_i2_staged_changes_outside_the_registered_workspace_are_refused() {
    let dir = testdir::fresh("embedded-git-staged")
        .canonicalize()
        .unwrap();
    let repo = initialize(&dir).unwrap();
    let workspace = dir.join("allowed");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(dir.join("elsewhere.gm"), "elsewhere\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("elsewhere.gm")).unwrap();
    index.write().unwrap();
    let reach = guard::Reach {
        roots: vec![workspace.clone()],
        ..Default::default()
    };
    let before = std::fs::read(repo.path().join("index")).unwrap();
    assert!(matches!(
        operate(
            &reach,
            &workspace,
            Operation::Commit {
                message: "outside".into(),
                automatic: false,
                scope: Some(Scope::Repository)
            }
        ),
        Err(Error {
            kind: ErrorKind::Invalid,
            ..
        })
    ));
    assert_eq!(std::fs::read(repo.path().join("index")).unwrap(), before);
    assert!(repo.head().is_err());
}

#[test]
fn adr0105_i2_two_workspaces_of_one_repository_serialize_commits() {
    let root = testdir::fresh("embedded-git-concurrent")
        .canonicalize()
        .unwrap();
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let repo = initialize(&root).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Fixture").unwrap();
    config
        .set_str("user.email", "fixture@example.test")
        .unwrap();
    std::fs::write(nested.join("a.gm"), "変更\n").unwrap();
    let reach = guard::Reach {
        roots: vec![root.clone(), nested.clone()],
        ..Default::default()
    };
    let start = std::sync::Barrier::new(2);
    let run = |workspace| {
        start.wait();
        operate(
            &reach,
            workspace,
            Operation::Commit {
                message: "Save current change".into(),
                automatic: false,
                scope: Some(Scope::Repository),
            },
        )
        .unwrap()
    };
    let (first, second) = std::thread::scope(|thread| {
        let first = thread.spawn(|| run(&root));
        let second = thread.spawn(|| run(&nested));
        (first.join().unwrap(), second.join().unwrap())
    });
    assert!(matches!(
        (first, second),
        (Response::Commit(Some(_)), Response::Commit(None))
            | (Response::Commit(None), Response::Commit(Some(_)))
    ));
    assert_eq!(history(&repo).unwrap().len(), 1);
}
