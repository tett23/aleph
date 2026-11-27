use crate::plugin_approval::{Access, Session};
use std::path::{Path, PathBuf};

fn scope() -> PathBuf {
    PathBuf::from("/test/manuscript.gm")
}

#[test]
fn adr0120_i1_pending_requests_are_grouped_and_cannot_be_used() {
    let mut session = Session::default();
    let a = session.open("one.js", "source").unwrap().channel;
    let b = session.open("one.js", "source").unwrap().channel;
    let Access::Waiting(mut first) = session.request(&a, scope()).unwrap() else {
        panic!("expected prompt")
    };
    let prompt = session.prompt().unwrap();
    let Access::Waiting(mut second) = session.request(&b, scope()).unwrap() else {
        panic!("expected same prompt")
    };
    assert_eq!(session.prompt().unwrap().id, prompt.id);
    assert!(!session.allows(&a, &scope(), &prompt.id));
    assert!(session.issue(&a, &scope()).unwrap().is_none());
    session.reply(&prompt.id, true, true).unwrap();
    assert!(first.try_recv().is_ok());
    assert!(second.try_recv().is_ok());
    let grant = session.issue(&a, &scope()).unwrap().unwrap();
    assert!(session.allows(&a, &scope(), &grant));
    assert!(!session.allows(&b, &scope(), &grant));
    assert!(session.prompt().is_none());
}

#[test]
fn adr0120_i2_only_the_visible_live_prompt_can_be_answered() {
    let mut session = Session::default();
    let a = session.open("one.js", "source").unwrap().channel;
    let b = session.open("two.js", "source").unwrap().channel;
    let Access::Waiting(mut first) = session.request(&a, scope()).unwrap() else {
        panic!("expected prompt")
    };
    let former = session.prompt().unwrap().id;
    let Access::Waiting(mut second) = session.request(&b, scope()).unwrap() else {
        panic!("expected queue")
    };
    assert_eq!(session.prompt().unwrap().id, former);
    session.close(&a);
    assert!(first.try_recv().is_err());
    assert!(session.reply(&former, true, true).is_err());
    let next = session.prompt().unwrap().id;
    session.reply(&next, true, false).unwrap();
    assert!(second.try_recv().is_ok());
    assert!(session.issue(&b, &scope()).unwrap().is_none());
    assert!(session.decisions().is_empty());
}

#[test]
fn adr0120_i3_reuse_binds_the_loaded_source_name_and_scope() {
    let mut session = Session::default();
    let a = session.open("one.js", "source").unwrap().channel;
    let _waiting = session.request(&a, scope()).unwrap();
    session
        .reply(&session.prompt().unwrap().id, true, true)
        .unwrap();
    let same = session.open("one.js", "source").unwrap().channel;
    assert!(matches!(
        session.request(&same, scope()).unwrap(),
        Access::Decided(Some(_))
    ));
    let changed = session.open("one.js", "changed").unwrap().channel;
    let renamed = session.open("two.js", "source").unwrap().channel;
    assert!(matches!(
        session.request(&changed, scope()).unwrap(),
        Access::Waiting(_)
    ));
    assert!(matches!(
        session.request(&renamed, scope()).unwrap(),
        Access::Waiting(_)
    ));
    assert!(matches!(
        session
            .request(&a, PathBuf::from("/test/other.gm"))
            .unwrap(),
        Access::Waiting(_)
    ));
}

#[test]
fn adr0120_i4_new_process_state_forgets_approvals_denials_and_grants() {
    let mut first = Session::default();
    let a = first.open("one.js", "source").unwrap().channel;
    let rejected = Path::new("/test/rejected.gm");
    for (path, allow) in [(scope(), true), (rejected.into(), false)] {
        let _waiting = first.request(&a, path).unwrap();
        first
            .reply(&first.prompt().unwrap().id, allow, true)
            .unwrap();
    }
    assert!(matches!(
        first.request(&a, rejected.into()).unwrap(),
        Access::Decided(None)
    ));
    let grant = first.issue(&a, &scope()).unwrap().unwrap();
    let mut restarted = Session::default();
    let a = restarted.open("one.js", "source").unwrap().channel;
    assert!(restarted.decisions().is_empty());
    assert!(!restarted.allows(&a, &scope(), &grant));
    assert!(matches!(
        restarted.request(&a, scope()).unwrap(),
        Access::Waiting(_)
    ));
    assert!(matches!(
        restarted.request(&a, rejected.into()).unwrap(),
        Access::Waiting(_)
    ));
}

#[test]
fn adr0120_i5_forgetting_an_approval_invalidates_all_related_grants() {
    let mut session = Session::default();
    let a = session.open("one.js", "source").unwrap().channel;
    let b = session.open("one.js", "source").unwrap().channel;
    let _waiting = session.request(&a, scope()).unwrap();
    let prompt = session.prompt().unwrap().id;
    session.reply(&prompt, true, true).unwrap();
    let first = session.issue(&a, &scope()).unwrap().unwrap();
    let second = session.issue(&b, &scope()).unwrap().unwrap();
    session.forget(&prompt);
    assert!(!session.allows(&a, &scope(), &first));
    assert!(!session.allows(&b, &scope(), &second));
    assert!(matches!(
        session.request(&b, scope()).unwrap(),
        Access::Waiting(_)
    ));
}
