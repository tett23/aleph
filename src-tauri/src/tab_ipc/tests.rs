use super::*;

#[test]
fn adr0115_i6_grant_requires_its_own_channel_scope_and_operation() {
    let registry = Registry::default();
    let first = registry
        .open(Some(PathBuf::from("/workspace/a.gm")))
        .unwrap();
    let second = registry
        .open(Some(PathBuf::from("/workspace/b.gm")))
        .unwrap();
    let scope = first.scope.as_deref().unwrap();
    let other_scope = second.scope.as_deref().unwrap();
    let token = registry
        .grant(&first.channel, scope, Permission::ReadSheetText)
        .unwrap();
    let permission = Permission::ReadSheetText;
    assert_eq!(
        registry
            .authorize(&first.channel, scope, &token, permission)
            .unwrap(),
        PathBuf::from("/workspace/a.gm")
    );
    assert!(registry
        .authorize(&first.channel, other_scope, &token, permission)
        .is_err());
    assert!(registry
        .authorize(&second.channel, other_scope, &token, permission)
        .is_err());
    assert!(registry
        .authorize(&first.channel, scope, &token, Permission::WriteSheetText)
        .is_err());
    assert!(registry.grant(&second.channel, scope, permission).is_err());
    assert!(registry
        .grant(&first.channel, scope, Permission::WriteSheetText)
        .is_err());
}

#[test]
fn adr0115_i6_close_revokes_the_channel_and_its_grants() {
    let registry = Registry::default();
    let first = registry
        .open(Some(PathBuf::from("/workspace/a.gm")))
        .unwrap();
    let second = registry
        .open(Some(PathBuf::from("/workspace/a.gm")))
        .unwrap();
    let scope = first.scope.as_deref().unwrap();
    let other_scope = second.scope.as_deref().unwrap();
    let permission = Permission::ReadSheetText;
    let token = registry.grant(&first.channel, scope, permission).unwrap();
    let other_token = registry
        .grant(&second.channel, other_scope, permission)
        .unwrap();
    registry.close(&first.channel).unwrap();
    assert!(registry
        .authorize(&first.channel, scope, &token, permission)
        .is_err());
    assert!(registry.grant(&first.channel, scope, permission).is_err());
    assert!(registry
        .authorize(&second.channel, other_scope, &other_token, permission)
        .is_ok());
}

#[test]
fn adr0115_i7_same_scope_is_allowed_independently_of_ui_type() {
    let registry = Registry::default();
    let target = PathBuf::from("/workspace/a.gm");
    let editor = registry.open(Some(target.clone())).unwrap();
    let preview = registry.open(Some(target.clone())).unwrap();
    let empty = registry.open(None).unwrap();
    let permission = Permission::ReadSheetText;
    for channel in [&editor, &preview] {
        let scope = channel.scope.as_deref().unwrap();
        let token = registry.grant(&channel.channel, scope, permission).unwrap();
        assert_eq!(
            registry
                .authorize(&channel.channel, scope, &token, permission)
                .unwrap(),
            target
        );
    }
    assert!(registry
        .grant(&empty.channel, editor.scope.as_deref().unwrap(), permission)
        .is_err());
    assert!(!editor.channel.eq(&preview.channel));
}

#[cfg(unix)]
#[test]
fn adr0115_i6_the_saved_sheet_is_read_and_a_replaced_path_is_rejected() {
    use std::os::unix::fs::symlink;

    let root = crate::fsops::testdir::fresh("tab-ipc")
        .canonicalize()
        .unwrap();
    let a = root.join("a.gm");
    let b = root.join("b.gm");
    fs::write(&a, "初めのシート").unwrap();
    fs::write(&b, "別のシート").unwrap();
    let reach = Reach {
        roots: vec![root.clone()],
        ..Reach::default()
    };
    let approved = approved_text(&reach, &a).unwrap();
    assert_eq!(read_bound_sheet(&reach, &approved).unwrap(), "初めのシート");
    assert!(read_bound_sheet(&Reach::default(), &approved).is_err());
    fs::remove_file(&a).unwrap();
    symlink(&b, &a).unwrap();
    assert!(read_bound_sheet(&reach, &approved).is_err());
    fs::remove_dir_all(root).unwrap();
}
