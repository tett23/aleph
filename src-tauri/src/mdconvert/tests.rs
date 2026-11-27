use super::*;

#[test]
fn adr0116_i2_adr0066_i1_registration_preserves_manifest_layout() {
    let cases = [
        ("chapters = []\n", "chapters = [\"章.gm\"]\n"),
        ("chapters = [\n]\n", "chapters = [\n  \"章.gm\"\n]\n"),
        (
            "chapters = [\"a.gm\", \"b.gm\",]\n[metadata]\n",
            "chapters = [\"a.gm\", \"b.gm\", \"章.gm\"]\n[metadata]\n",
        ),
        (
            "chapters = [\n  \"a.gm\" # keep\n]\n",
            "chapters = [\n  \"a.gm\", # keep\n  \"章.gm\"\n]\n",
        ),
        (
            "chapters = [\n  \"a.gm\"]\n",
            "chapters = [\n  \"a.gm\", \"章.gm\"]\n",
        ),
        (
            "chapters = [\n  { file = \"a.gm\", paragraph-separator = \"line\" },\n]\n",
            "chapters = [\n  { file = \"a.gm\", paragraph-separator = \"line\" },\n  \"章.gm\"\n]\n",
        ),
        ("[metadata]\n", "chapters = [\"章.gm\"]\n[metadata]\n"),
        (
            "chapters = [\"a.gm\", [\"b1.gm\", \"b2.gm\"], \"c.gm\"]\n",
            "chapters = [\"a.gm\", [\"b1.gm\", \"b2.gm\"], \"c.gm\", \"章.gm\"]\n",
        ),
    ];
    for (source, expected) in cases {
        let (text, registered) = manifest::update(source, "章.gm", ChapterMode::Add).unwrap();
        assert_eq!(text, expected);
        assert!(registered);
        assert_eq!(
            manifest::update(&text, "章.gm", ChapterMode::Add)
                .unwrap()
                .0,
            expected
        );
    }
    assert_eq!(
        manifest::update("chapters = []", "a\"b.gm", ChapterMode::Add)
            .unwrap()
            .0,
        "chapters = [\"a\\\"b.gm\"]"
    );
}

#[test]
fn adr0116_i2_toggle_removes_nested_duplicates_and_preserves_other_items() {
    let source = "chapters = [\n  \"a.gm\",\n  [\"x.gm\", { file = \"x.gm\", paragraph-separator = \"line\" }],\n  { file = \"b.gm\", paragraph-separator = \"line\" },\n]\n";
    let (text, registered) = manifest::update(source, "x.gm", ChapterMode::Toggle).unwrap();
    assert_eq!(
        text,
        "chapters = [\n  \"a.gm\",\n  { file = \"b.gm\", paragraph-separator = \"line\" },\n]\n"
    );
    assert!(!registered);
    assert_eq!(
        manifest::update("chapters = [\"x.gm\",]\n", "x.gm", ChapterMode::Toggle)
            .unwrap()
            .0,
        "chapters = []\n"
    );
}

#[test]
fn adr0116_i2_separator_checks_the_chapter_before_source_defaults() {
    let manifest = "chapters = [\"a.gm\", [{ file = \"b.gm\", paragraph-separator = \"blank-line\" }]]\n[source]\nparagraph-separator = \"line\"\n";
    assert!(matches!(
        super::manifest::separator(manifest, "a.gm").unwrap(),
        Separator::Line
    ));
    assert!(matches!(
        super::manifest::separator(manifest, "b.gm").unwrap(),
        Separator::BlankLine
    ));
}

#[test]
fn adr0116_i3_conversion_validates_the_plan_before_writing_both_files() {
    let root = crate::fsops::testdir::fresh("mdconvert")
        .canonicalize()
        .unwrap();
    let source = root.join("source.md");
    let destination = root.join("source.gm");
    let manifest = root.join("manifest.toml");
    let roots = [root.clone()];
    let reach = Reach {
        roots: roots.to_vec(),
        ..Reach::default()
    };
    fs::write(&source, "# ディスク\n").unwrap();
    fs::write(&manifest, "[source]\nparagraph-separator = \"line\"\n").unwrap();
    let plan = prepare(&reach, &roots, &source, Some(&root)).unwrap();
    let revision = plan.revision();
    let before = fs::read_to_string(&manifest).unwrap();
    fs::write(&destination, "# 他のエディタ\n").unwrap();
    let current = prepare(&reach, &roots, &source, Some(&root)).unwrap();
    assert!(apply(current, &roots, &revision, true, Some("# 編集中\n".into())).is_err());
    assert_eq!(fs::read_to_string(&manifest).unwrap(), before);
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "# 他のエディタ\n"
    );

    let plan = prepare(&reach, &roots, &source, Some(&root)).unwrap();
    let revision = plan.revision();
    assert!(apply(plan, &roots, &revision, false, Some("# 編集中\n".into())).is_err());
    fs::write(&manifest, format!("{}# 追記\n", before)).unwrap();
    let current = prepare(&reach, &roots, &source, Some(&root)).unwrap();
    assert!(apply(current, &roots, &revision, true, Some("# 編集中\n".into())).is_err());
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "# 他のエディタ\n"
    );

    let plan = prepare(&reach, &roots, &source, Some(&root)).unwrap();
    let revision = plan.revision();
    let outcome = apply(
        plan,
        &roots,
        &revision,
        true,
        Some("# 編集中\n\n一行\n二行\n".into()),
    )
    .unwrap();
    assert!(outcome.chapter_registered);
    assert_eq!(fs::read_to_string(&source).unwrap(), "# ディスク\n");
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "# 編集中\n\n一行二行\n"
    );
    assert_eq!(
        fs::read_to_string(&manifest).unwrap(),
        format!("chapters = [\"source.gm\"]\n{}# 追記\n", before)
    );
    fs::remove_dir_all(root).unwrap();
}
