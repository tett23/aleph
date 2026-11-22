use super::*;
use crate::fsops::testdir::fresh;

fn fixture() -> Plan {
    let workspace = fresh("tree-move");
    fs::create_dir_all(workspace.join("a/draft/children")).unwrap();
    fs::create_dir_all(workspace.join("b")).unwrap();
    fs::write(workspace.join("a/draft/children/page.gm"), "本文").unwrap();
    Plan {
        from: workspace.join("a/draft"),
        to: workspace.join("b/draft"),
        workspace,
        documents: Vec::new(),
        directories: Vec::new(),
        writes: Vec::new(),
    }
}

#[test]
fn adr0100_i1_i3_move_preserves_names_and_descendants_without_overwrite() {
    let plan = fixture();
    let stay = plan.to.parent().unwrap().join("stay.gm");
    fs::write(&stay, "stay").unwrap();
    assert!(
        apply(&plan, std::slice::from_ref(&plan.workspace))
            .unwrap()
            .moved
    );
    assert!(!plan.from.exists());
    assert_eq!(
        fs::read_to_string(plan.to.join("children/page.gm")).unwrap(),
        "本文"
    );
    assert_eq!(fs::read_to_string(stay).unwrap(), "stay");
}

#[test]
fn adr0100_i2_i3_same_parent_root_nested_workspace_and_collision_are_refused() {
    let mut plan = fixture();
    let dest = plan.to.clone();
    plan.to = plan.from.clone();
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    plan.to = plan.from.join("children/draft");
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    plan.to = dest;
    assert!(apply(&plan, &[plan.workspace.clone(), plan.workspace.join("a")]).is_err());
    assert!(apply(&plan, &[plan.workspace.clone(), plan.workspace.join("b")]).is_err());
    fs::create_dir(&plan.to).unwrap();
    let other = plan.to.join("keep.gm");
    fs::write(&other, "different").unwrap();
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    assert_eq!(fs::read_to_string(other).unwrap(), "different");
    assert!(plan.from.exists());
}

#[test]
fn adr0100_i2_i3_project_nesting_protected_settings_and_symlinks_are_refused() {
    let mut plan = fixture();
    let project = plan.from.join("children");
    fs::write(project.join(MANIFEST), "nested").unwrap();
    fs::write(plan.workspace.join("b/manifest.toml"), "project").unwrap();
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    let alias = plan.workspace.join("link");
    std::os::unix::fs::symlink(plan.to.parent().unwrap(), &alias).unwrap();
    plan.to = alias.join("draft");
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    plan.from = project.join(MANIFEST);
    plan.to = plan.workspace.join(MANIFEST);
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
}

#[test]
fn adr0100_i2_i5_stale_directory_inventory_or_text_stops_before_moving() {
    let mut plan = fixture();
    let path = plan.from.join("children/page.gm");
    plan.documents.push(Document {
        path,
        text: "stale".into(),
    });
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    plan.documents.clear();
    plan.directories.push(Directory {
        path: plan.from.clone(),
        entries: Vec::new(),
    });
    assert!(apply(&plan, std::slice::from_ref(&plan.workspace)).is_err());
    assert!(plan.from.exists());
    assert!(!plan.to.exists());
}

#[test]
fn adr0100_i2_i5_i7_failed_metadata_write_rolls_back_reference_and_path() {
    let mut plan = fixture();
    let chapter = plan.from.join("children/page.gm");
    let notes = plan.workspace.join("b/.aleph/notes.json");
    plan.writes = vec![
        DiskWrite {
            path: chapter.clone(),
            before: Some("本文".into()),
            after: "新しい参照".into(),
        },
        DiskWrite {
            path: notes.clone(),
            before: None,
            after: "{}".into(),
        },
    ];
    let outcome = stages(&plan, std::slice::from_ref(&plan.workspace), |p| {
        if p == notes {
            return Err("injected metadata failure".into());
        }
        Ok(())
    })
    .unwrap();
    assert!(!outcome.moved);
    assert!(outcome.error.unwrap().contains("injected metadata failure"));
    assert_eq!(fs::read_to_string(chapter).unwrap(), "本文");
    assert!(!plan.to.exists());
}

#[test]
fn adr0100_i3_i7_external_edits_and_failed_path_restore_are_reported_and_kept() {
    let mut plan = fixture();
    let chapter = plan.from.join("children/page.gm");
    let moved_chapter = plan.to.join("children/page.gm");
    let notes = plan.workspace.join("b/.aleph/notes.json");
    plan.writes = vec![
        DiskWrite {
            path: chapter,
            before: Some("本文".into()),
            after: "新しい参照".into(),
        },
        DiskWrite {
            path: notes.clone(),
            before: None,
            after: "{}".into(),
        },
    ];
    let outcome = stages(&plan, std::slice::from_ref(&plan.workspace), |p| {
        if p == notes {
            fs::write(&moved_chapter, "outside edit").unwrap();
            fs::create_dir(&plan.from).unwrap();
            return Err(at(p, "metadata failure"));
        }
        Ok(())
    })
    .unwrap();
    assert!(outcome.moved);
    let error = outcome.error.unwrap();
    for path in [&notes, &moved_chapter, &plan.from] {
        assert!(error.contains(path.to_str().unwrap()), "{error}");
    }
    assert_eq!(fs::read_to_string(moved_chapter).unwrap(), "outside edit");
}

#[test]
fn adr0100_i3_i7_rollback_keeps_external_text_that_happens_to_equal_the_planned_edit() {
    let mut plan = fixture();
    let chapter = plan.from.join("children/page.gm");
    let moved = plan.to.join("children/page.gm");
    plan.writes = vec![DiskWrite {
        path: chapter.clone(),
        before: Some("本文".into()),
        after: "同じ文".into(),
    }];
    let outcome = stages(&plan, std::slice::from_ref(&plan.workspace), |path| {
        assert_eq!(path, moved);
        fs::write(path, "同じ文").unwrap();
        Ok(())
    })
    .unwrap();
    assert!(!outcome.moved && outcome.error.is_some());
    assert_eq!(fs::read_to_string(chapter).unwrap(), "同じ文");
}

#[test]
fn adr0100_i4_i7_replaced_destination_is_not_reported_as_the_moved_item() {
    let mut plan = fixture();
    let elsewhere = plan.workspace.join("b/elsewhere");
    plan.writes.push(DiskWrite {
        path: plan.workspace.join("b/.aleph/notes.json"),
        before: None,
        after: "{}".into(),
    });
    let outcome = stages(&plan, std::slice::from_ref(&plan.workspace), |path| {
        fs::rename(&plan.to, &elsewhere).unwrap();
        fs::create_dir(&plan.to).unwrap();
        Err(at(path, "後続の編集に失敗しました"))
    })
    .unwrap();
    assert!(!outcome.moved);
    assert!(outcome.error.unwrap().contains(plan.to.to_str().unwrap()));
    assert!(elsewhere.join("children/page.gm").is_file());
    assert!(!plan.to.join("children/page.gm").exists());
}

#[test]
fn adr0100_i2_i5_new_reference_in_read_only_dependency_aborts_before_commit() {
    let mut plan = fixture();
    let dependency = plan.workspace.join("index.md");
    fs::write(&dependency, "no links").unwrap();
    plan.documents.push(Document {
        path: dependency.clone(),
        text: "no links".into(),
    });
    let notes = plan.workspace.join("b/.aleph/notes.json");
    plan.writes.push(DiskWrite {
        path: notes.clone(),
        before: None,
        after: "{}".into(),
    });
    let outcome = stages(&plan, std::slice::from_ref(&plan.workspace), |_| {
        fs::write(&dependency, "[[a/draft/children/page.gm]]").unwrap();
        Ok(())
    })
    .unwrap();
    assert!(!outcome.moved);
    assert!(outcome
        .error
        .unwrap()
        .contains(dependency.to_str().unwrap()));
    assert!(!notes.exists());
    assert!(plan.from.exists());
    assert!(!plan.to.exists());
}
