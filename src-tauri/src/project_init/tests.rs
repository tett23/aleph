use super::*;
use crate::fsops::testdir::fresh;
use std::os::unix::fs::{symlink, PermissionsExt};

fn generate_fake(
    root: &Path,
    cache: &Path,
    generate: impl FnOnce(&Path, &str) -> Result<()>,
) -> Result<()> {
    initialize_with(root, cache, generate, |_| Ok(()))
}

fn template(root: &Path) {
    fs::create_dir_all(root.join("chapters")).unwrap();
    fs::write(root.join("chapters/01.gm"), "new text").unwrap();
    fs::write(root.join("style.toml"), "[page]\n").unwrap();
    fs::write(
        root.join("manifest.toml"),
        "chapters = [\"chapters/01.gm\"]\n[metadata]\ntitle = \"A\"\n",
    )
    .unwrap();
}

#[test]
fn adr0101_i1_i2_generated_files_join_the_existing_root_with_manifest_last() {
    let root = fresh("initialize-root");
    let stage = fresh("initialize-stage");
    template(&stage);
    fs::create_dir(root.join(".git")).unwrap();
    fs::create_dir(root.join("chapters")).unwrap();
    fs::write(root.join("chapters/draft.gm"), "old text").unwrap();
    let mut order = Vec::new();
    install(&root, &stage, |path| {
        assert!(!root.join("manifest.toml").exists());
        order.push(path.to_owned());
        Ok(())
    })
    .unwrap();
    assert_eq!(order.last().unwrap(), Path::new("manifest.toml"));
    assert_eq!(
        fs::read(root.join("manifest.toml")).unwrap(),
        fs::read(stage.join("manifest.toml")).unwrap()
    );
    assert_eq!(
        fs::read_to_string(root.join("chapters/01.gm")).unwrap(),
        "new text"
    );
    assert_eq!(
        fs::read_to_string(root.join("chapters/draft.gm")).unwrap(),
        "old text"
    );
    assert!(root.join(".git").is_dir());
    assert!(!root.join(root.file_name().unwrap()).exists());
}

#[test]
fn adr0101_i3_preflight_reports_all_conflicts_and_refuses_a_subproject_or_scan_error() {
    let root = fresh("initialize-conflicts");
    let stage = fresh("initialize-stage");
    template(&stage);
    fs::write(root.join("style.toml"), "my style").unwrap();
    fs::write(root.join("chapters"), "a file").unwrap();
    let err = install(&root, &stage, |_| panic!("preflight reached placement")).unwrap_err();
    assert!(
        err.contains("style.toml") && err.contains("chapters"),
        "{err}"
    );
    assert!(!root.join("manifest.toml").exists());
    assert_eq!(
        fs::read_to_string(root.join("style.toml")).unwrap(),
        "my style"
    );

    let root = fresh("initialize-subproject");
    fs::create_dir(root.join("inner")).unwrap();
    fs::write(root.join("inner/manifest.toml"), "project").unwrap();
    let err = install(&root, &stage, |_| panic!("preflight reached placement")).unwrap_err();
    assert!(err.contains("inner"), "{err}");
    assert!(!root.join("style.toml").exists());
    let err = install(&root.join("missing"), &stage, |_| {
        panic!("preflight reached placement")
    })
    .unwrap_err();
    assert!(err.contains("missing"), "{err}");
}

#[test]
fn adr0101_i3_i4_permission_symlink_and_racing_collisions_preserve_existing_files() {
    let stage = fresh("initialize-stage");
    template(&stage);
    let root = fresh("initialize-race");
    let outside = fresh("initialize-outside");
    symlink(&outside, root.join("chapters")).unwrap();
    assert!(install(&root, &stage, |_| panic!("symlink reached placement")).is_err());
    assert!(!outside.join("01.gm").exists());
    fs::remove_file(root.join("chapters")).unwrap();
    fs::create_dir(root.join("chapters")).unwrap();
    fs::set_permissions(root.join("chapters"), fs::Permissions::from_mode(0o500)).unwrap();
    assert!(install(&root, &stage, |_| panic!(
        "unwritable directory reached placement"
    ))
    .is_err());
    fs::set_permissions(root.join("chapters"), fs::Permissions::from_mode(0o700)).unwrap();
    let err = install(&root, &stage, |p| {
        if p == Path::new("style.toml") {
            fs::write(root.join("style.toml"), "racer").unwrap();
            fs::write(root.join("chapters/01.gm"), "externally edited").unwrap();
        }
        Ok(())
    })
    .unwrap_err();
    assert!(
        err.contains("style.toml") && err.contains("chapters/01.gm"),
        "{err}"
    );
    assert_eq!(
        fs::read_to_string(root.join("style.toml")).unwrap(),
        "racer"
    );
    assert_eq!(
        fs::read_to_string(root.join("chapters/01.gm")).unwrap(),
        "externally edited"
    );
    assert!(!root.join("manifest.toml").exists());
}

#[test]
fn adr0101_i3_failed_golem_and_incomplete_generation_never_start_placement() {
    let root = fresh("initialize-generator");
    let cache = fresh("initialize-cache");
    assert!(
        generate_fake(&root, &cache, |_, _| Err("golem unavailable".into()))
            .unwrap_err()
            .contains("unavailable")
    );
    assert!(generate_fake(&root, &cache, |stage, name| {
        fs::create_dir(stage.join(name)).unwrap();
        fs::write(
            stage.join(name).join("manifest.toml"),
            "chapters = [\"missing.gm\"]",
        )
        .unwrap();
        Ok(())
    })
    .is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    assert_eq!(fs::read_dir(cache).unwrap().count(), 0);
}

#[test]
fn adr0101_i1_i4_failure_removes_pristine_items_and_retains_outside_changes() {
    let root = fresh("initialize-removes-pristine");
    let stage = fresh("initialize-stage");
    template(&stage);
    let error = install(&root, &stage, |path| {
        if path == Path::new("manifest.toml") {
            fs::write(root.join("chapters/01.gm"), "edited").unwrap();
        }
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("chapters/01.gm"), "{error}");
    assert_eq!(
        fs::read_to_string(root.join("chapters/01.gm")).unwrap(),
        "edited"
    );
    assert!(!root.join("style.toml").exists());
    assert!(!root.join("manifest.toml").exists());

    let root = fresh("initialize-removes-empty-directory");
    let error = install(&root, &stage, |path| {
        if path == Path::new("manifest.toml") {
            return Err("injected failure".into());
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error, "injected failure");
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[test]
fn adr0101_i3_i4_second_initialization_and_existing_font_are_preserved() {
    let root = fresh("initialize-twice");
    let cache = fresh("initialize-cache");
    generate_fake(&root, &cache, |stage, name| {
        let error = generate_fake(&root, &cache, |_, _| {
            panic!("the second operation ran Golem")
        })
        .unwrap_err();
        assert!(error.contains("初期化を実行中"), "{error}");
        template(&stage.join(name));
        Ok(())
    })
    .unwrap();
    let source = cache.join("font.otf");
    fs::write(&source, "library font").unwrap();
    let target = root.join("fonts/font.otf");
    copy_new_file(&root, &source, &target).unwrap();
    fs::write(&source, "another font").unwrap();
    assert!(copy_new_file(&root, &source, &target).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "library font");
}

#[test]
#[ignore = "ALEPH_TEST_GOLEM must name the bundled Golem executable"]
fn adr0101_i1_bundled_golem_generates_the_manifest_for_the_registered_directory_name() {
    let folder = fresh("initialize-bundled-golem");
    let root = folder.join("作品の原稿");
    let cache = folder.join("cache");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&cache).unwrap();
    fs::write(root.join("notes.md"), "my note").unwrap();
    let golem = std::env::var_os("ALEPH_TEST_GOLEM").unwrap();
    let original = std::cell::RefCell::new(Vec::new());
    initialize(&root, &cache, |cwd, args| {
        let result = crate::process::run(Path::new(&golem), cwd, args)?;
        if args[0] == "new" {
            assert_eq!(args[1], "./作品の原稿");
            *original.borrow_mut() = fs::read(cwd.join(&args[1]).join(MANIFEST)).unwrap();
        }
        Ok(result)
    })
    .unwrap();
    assert_eq!(
        fs::read(root.join("manifest.toml")).unwrap(),
        original.into_inner()
    );
    assert!(root.join("chapters/01.gm").is_file());
    assert_eq!(
        fs::read_to_string(root.join("notes.md")).unwrap(),
        "my note"
    );
    assert_eq!(fs::read_dir(cache).unwrap().count(), 0);
    fs::remove_dir_all(folder).unwrap();
}

#[test]
fn adr0101_i4_rollback_preserves_an_externally_touched_empty_directory() {
    let root = fresh("initialize-touch-directory");
    let stage = fresh("initialize-stage");
    template(&stage);
    let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    let error = install(&root, &stage, |path| {
        if path == Path::new("manifest.toml") {
            File::open(root.join("chapters"))
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
            return Err("injected failure".into());
        }
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("chapters"), "{error}");
    assert!(root.join("chapters").is_dir());
    assert_eq!(fs::read_dir(root.join("chapters")).unwrap().count(), 0);
    assert!(!root.join("manifest.toml").exists());
}

#[test]
#[ignore = "ALEPH_TEST_GOLEM must name the bundled Golem executable"]
fn adr0101_i3_malformed_generated_manifest_never_reaches_the_root() {
    let root = fresh("initialize-malformed-manifest");
    let cache = fresh("initialize-cache");
    let golem = std::env::var_os("ALEPH_TEST_GOLEM").unwrap();
    let error = initialize(&root, &cache, |cwd, args| {
        let result = crate::process::run(Path::new(&golem), cwd, args)?;
        if args[0] == "new" {
            let mut manifest = fs::OpenOptions::new()
                .append(true)
                .open(cwd.join(&args[1]).join(MANIFEST))
                .unwrap();
            writeln!(manifest, "[broken").unwrap();
        }
        Ok(result)
    })
    .unwrap_err();
    assert!(error.contains("manifest.toml"));
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}
