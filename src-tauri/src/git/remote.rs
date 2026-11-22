//! Branch-scoped HTTPS and SSH transport, and safe integration after fetch.
use super::{
    check_filter, check_filter_with_flags, find_head, identity, status_entries, Error, ErrorKind,
    Result,
};
use git2::build::CheckoutBuilder;
use git2::{
    AnnotatedCommit, AttrCheckFlags, AutotagOption, Cred, CredentialType, Direction, ErrorCode,
    FetchOptions, Index, ProxyOptions, PushOptions, Remote, RemoteCallbacks, RemoteRedirect,
    Repository, RepositoryState, Tree,
};
use serde::Deserialize;
use std::cell::Cell;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    username: String,
    password: String,
    target: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Protocol {
    Https,
    Ssh,
}

fn protocol(url: &str) -> Result<Protocol> {
    let invalid = || Error::invalid("Git の接続先には HTTPS または SSH の URL を指定してください");
    if let Some(https) = url.strip_prefix("https://") {
        let authority = https.split('/').next().unwrap_or_default();
        if authority.is_empty()
            || authority
                .rsplit_once('@')
                .is_some_and(|(user, _)| user.contains(':'))
        {
            return Err(invalid());
        }
        return Ok(Protocol::Https);
    }
    if url.starts_with("ssh://") {
        return Ok(Protocol::Ssh);
    }
    if url.contains("://") {
        return Err(invalid());
    }
    if let Some((host, path)) = url.split_once(':') {
        if !host.is_empty()
            && !host.starts_with('-')
            && !host.contains(['/', '\\'])
            && !path.is_empty()
            && !path.starts_with(':')
        {
            return Ok(Protocol::Ssh);
        }
    }
    Err(invalid())
}

#[derive(Default)]
struct Exchange {
    requested_secret: Cell<bool>,
    used_secret: Cell<bool>,
    ssh_agent_used: Cell<bool>,
    username_used: Cell<bool>,
    rejected: Cell<bool>,
}

impl Exchange {
    fn callbacks<'a>(
        &'a self,
        protocol: Protocol,
        credentials: Option<&'a Credentials>,
    ) -> RemoteCallbacks<'a> {
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(move |_, user, allowed| {
            if protocol == Protocol::Ssh {
                if allowed.contains(CredentialType::USERNAME) && !self.username_used.replace(true) {
                    if let Some(user) = user {
                        return Cred::username(user);
                    }
                }
                if allowed.contains(CredentialType::SSH_KEY) && !self.ssh_agent_used.replace(true) {
                    if let Some(user) = user {
                        return Cred::ssh_key_from_agent(user);
                    }
                }
            } else if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
                self.requested_secret.set(true);
                if let Some(credentials) = credentials.filter(|_| !self.used_secret.replace(true)) {
                    return Cred::userpass_plaintext(&credentials.username, &credentials.password);
                }
            }
            Err(git2::Error::new(
                ErrorCode::Auth,
                git2::ErrorClass::Net,
                "authentication required",
            ))
        });
        callbacks.push_update_reference(|_, reason| {
            if reason.is_some() {
                self.rejected.set(true);
            }
            Ok(())
        });
        // Leave the certificate callback unset. libgit2 must verify both the
        // HTTPS certificate chain and the SSH host key against known_hosts.
        callbacks
    }

    fn outcome(
        &self,
        protocol: Protocol,
        target: String,
        result: std::result::Result<(), git2::Error>,
    ) -> Result<()> {
        match result {
            Err(error) if error.code() == ErrorCode::Certificate => Err(Error::new(ErrorKind::Certificate, match protocol {
                Protocol::Https => "HTTPS 証明書を検証できません",
                Protocol::Ssh => "SSH ホスト鍵を検証できません。接続先の鍵を確認し、既知ホストの設定に登録してください",
            })),
            Err(_) if self.rejected.get() => Err(Error::invalid("リモートが push を拒否しました")),
            Err(_) if protocol == Protocol::Https && self.requested_secret.get() && !self.used_secret.get() => {
                let mut error = Error::new(ErrorKind::AuthRequired, "HTTPS のユーザー名とパスワードまたはトークンを入力してください");
                error.auth_target = Some(target);
                Err(error)
            }
            Err(error) if error.code() == ErrorCode::NotFastForward => Err(Error::invalid("リモートの履歴が先に進んでいるため push できません")),
            Err(error) if error.code() == ErrorCode::Auth || self.ssh_agent_used.get() && error.class() == git2::ErrorClass::Ssh => {
                Err(Error::new(ErrorKind::Authentication, match protocol {
                    Protocol::Https => "HTTPS 認証に失敗しました",
                    Protocol::Ssh => "SSH エージェントで認証できません",
                }))
            }
            Err(_) => Err(Error::new(ErrorKind::Read, "Git のリモート操作に失敗しました")),
            Ok(()) if self.rejected.get() => Err(Error::invalid("リモートが push を拒否しました")),
            Ok(()) => Ok(()),
        }
    }
}

fn current_branch(repo: &Repository) -> Result<String> {
    let reference = repo.find_reference("HEAD")?;
    let name = reference
        .symbolic_target()?
        .filter(|name| name.starts_with("refs/heads/"));
    name.map(str::to_owned)
        .ok_or_else(|| Error::invalid("現在の Git ブランチがありません"))
}

fn tracking<'a>(repo: &'a Repository, branch: &str) -> Result<(Remote<'a>, String)> {
    let fail = || Error::invalid("現在のブランチに追跡先のリモートとブランチを設定してください");
    let name = repo.branch_upstream_remote(branch).map_err(|_| fail())?;
    let target = repo.branch_upstream_merge(branch).map_err(|_| fail())?;
    let name = name.as_str()?;
    let target = target
        .as_str()
        .ok()
        .filter(|name| name.starts_with("refs/heads/"))
        .ok_or_else(fail)?;
    Ok((repo.find_remote(name)?, target.to_owned()))
}

fn push_target<'a>(repo: &'a Repository, branch: &str) -> Result<(Remote<'a>, String)> {
    let config = repo.config()?;
    let short = branch.strip_prefix("refs/heads/").unwrap_or(branch);
    let explicit = config
        .get_string(&format!("branch.{short}.pushRemote"))
        .ok()
        .or_else(|| config.get_string("remote.pushDefault").ok());
    let (remote, upstream) = if let Some(name) = explicit {
        let remote = repo.find_remote(&name)?;
        let upstream = tracking(repo, branch)
            .ok()
            .filter(|(tracking, _)| tracking.name().ok().flatten() == Some(name.as_str()))
            .map(|(_, branch)| branch);
        (remote, upstream.unwrap_or_else(|| branch.to_owned()))
    } else {
        tracking(repo, branch)?
    };
    let mut selected = remote
        .refspecs()
        .filter(|spec| spec.direction() == Direction::Push && spec.src_matches(branch));
    let target = if let Some(spec) = selected.next() {
        if selected.next().is_some() {
            return Err(Error::invalid("現在のブランチの push 先が複数あります"));
        }
        let target = spec.transform(branch)?;
        target
            .as_str()
            .ok()
            .filter(|name| name.starts_with("refs/heads/"))
            .ok_or_else(|| Error::invalid("push 先のブランチを確認できません"))?
            .to_owned()
    } else {
        upstream
    };
    Ok((remote, target))
}

// Named remotes can update extra refs through their passive refspecs even
// when the caller passes an explicit refspec. Use a remote with no saved
// refspecs after resolving the configured destination.
fn scoped_remote<'a>(repo: &'a Repository, url: &str) -> Result<Remote<'a>> {
    protocol(url)?;
    repo.remote_anonymous(url)
        .map_err(|_| Error::invalid("Git の接続先を確認できません"))
}

fn auth_target(
    repo: &Repository,
    url: &str,
    action: &str,
    refspec: &str,
    credentials: Option<&Credentials>,
) -> Result<String> {
    let target = crate::sha256::hex(
        format!("{}\0{action}\0{refspec}\0{url}", repo.path().display()).as_bytes(),
    );
    if credentials.is_some_and(|credentials| credentials.target != target) {
        return Err(Error::new(
            ErrorKind::TargetChanged,
            "Git の認証先が変わりました。操作をやり直してください",
        ));
    }
    Ok(target)
}

pub fn push(repo: &Repository, credentials: Option<&Credentials>) -> Result<()> {
    let branch = current_branch(repo)?;
    let (configured, destination) = push_target(repo, &branch)?;
    let url = configured.pushurl()?.unwrap_or(configured.url()?);
    let mut remote = scoped_remote(repo, url)?;
    let protocol = protocol(remote.url()?)?;
    let refspec = format!("{branch}:{destination}");
    let target = auth_target(repo, remote.url()?, "push", &refspec, credentials)?;
    let exchange = Exchange::default();
    let mut options = PushOptions::new();
    options
        .remote_callbacks(exchange.callbacks(protocol, credentials))
        .follow_redirects(RemoteRedirect::None)
        .proxy_options(ProxyOptions::new());
    let result = remote.push(&[refspec], Some(&mut options));
    exchange.outcome(protocol, target, result)
}

fn clean(repo: &Repository) -> Result<()> {
    if repo.state() != RepositoryState::Clean || repo.index()?.has_conflicts() {
        return Err(Error::new(
            ErrorKind::Conflict,
            "Git の競合を解消してから手動でコミットしてください",
        ));
    }
    if !status_entries(repo)?.is_empty() {
        return Err(Error::new(ErrorKind::Dirty, "作業ツリーまたはステージにローカルの変更があります。コミットしてから pull してください"));
    }
    Ok(())
}

pub fn pull(repo: &Repository, credentials: Option<&Credentials>) -> Result<()> {
    clean(repo)?;
    let branch = current_branch(repo)?;
    let (configured, source) = tracking(repo, &branch)?;
    let tracking = repo.branch_upstream_name(&branch)?;
    let tracking = tracking
        .as_str()
        .ok()
        .filter(|name| name.starts_with("refs/remotes/"))
        .ok_or_else(|| Error::invalid("リモート追跡ブランチを確認できません"))?;
    let mut remote = scoped_remote(repo, configured.url()?)?;
    let protocol = protocol(remote.url()?)?;
    let refspec = format!("+{source}:{tracking}");
    let target = auth_target(repo, remote.url()?, "pull", &refspec, credentials)?;
    let exchange = Exchange::default();
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(exchange.callbacks(protocol, credentials))
        .follow_redirects(RemoteRedirect::None)
        .proxy_options(ProxyOptions::new())
        .download_tags(AutotagOption::None);
    // Fetch one configured branch into its tracking ref. Other configured
    // fetch refspecs cannot update local branches through this operation.
    let result = remote.fetch(&[refspec], Some(&mut options), None);
    exchange.outcome(protocol, target, result)?;
    clean(repo)?;
    if branch != current_branch(repo)? {
        return Err(Error::new(
            ErrorKind::TargetChanged,
            "Git のブランチが変わりました",
        ));
    }
    let incoming = repo.reference_to_annotated_commit(&repo.find_reference(tracking)?)?;
    integrate(repo, &branch, &incoming)
}

fn checkout() -> CheckoutBuilder<'static> {
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().overwrite_ignored(false);
    checkout
}

fn check_checkout(repo: &Repository, old: Option<&Tree<'_>>, incoming: &Tree<'_>) -> Result<()> {
    let inspection = Repository::open(repo.path())?;
    let mut index = Index::new()?;
    index.read_tree(incoming)?;
    inspection.set_index(&mut index)?;
    let delta = repo.diff_tree_to_tree(old, Some(incoming), None)?;
    for entry in delta.deltas() {
        if let Some(path) = entry
            .new_file()
            .path()
            .filter(|_| entry.status() != git2::Delta::Deleted)
        {
            check_filter(repo, path)?;
            check_filter_with_flags(&inspection, path, AttrCheckFlags::INDEX_ONLY)?;
        }
    }
    Ok(())
}

fn checkout_error(error: git2::Error) -> Error {
    if matches!(
        error.code(),
        ErrorCode::Conflict | ErrorCode::IndexDirty | ErrorCode::Uncommitted
    ) {
        Error::new(
            ErrorKind::Dirty,
            "Git の統合で上書きされるローカルの変更があります",
        )
    } else {
        error.into()
    }
}

fn integrate(repo: &Repository, branch: &str, incoming: &AnnotatedCommit<'_>) -> Result<()> {
    let (analysis, _) = repo.merge_analysis(&[incoming])?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    let current = find_head(repo)?
        .map(|head| head.peel_to_commit())
        .transpose()?;
    let their = repo.find_commit(incoming.id())?;
    let our_tree = current.as_ref().map(git2::Commit::tree).transpose()?;
    let their_tree = their.tree()?;
    if analysis.is_fast_forward() || analysis.is_unborn() {
        check_checkout(repo, our_tree.as_ref(), &their_tree)?;
        let mut transaction = repo.transaction()?;
        transaction.lock_ref(branch)?;
        let expected = current.as_ref().map(git2::Commit::id);
        let actual = find_head(repo)?.and_then(|head| head.target());
        if expected != actual {
            return Err(Error::new(
                ErrorKind::TargetChanged,
                "Git のブランチが変わりました",
            ));
        }
        repo.checkout_tree(their.as_object(), Some(&mut checkout()))
            .map_err(checkout_error)?;
        // Fast-forward creates no commit, so a commit identity is unnecessary.
        transaction.set_target(branch, their.id(), None, "pull: fast-forward")?;
        transaction.commit()?;
        return Ok(());
    }
    if !analysis.is_normal() {
        return Err(Error::invalid(
            "現在の Git ブランチに追跡先を統合できません",
        ));
    }
    let signature = identity::signature(repo, &repo.config()?)?;
    let ours =
        current.ok_or_else(|| Error::invalid("現在の Git ブランチにコミットがありません"))?;
    let base = repo.merge_base(ours.id(), their.id())?;
    let base = repo.find_commit(base)?.tree()?;
    check_checkout(repo, Some(&base), &their_tree)?;
    let mut preview = repo.merge_commits(&ours, &their, None)?;
    if !preview.has_conflicts() {
        let tree = repo.find_tree(preview.write_tree_to(repo)?)?;
        check_checkout(repo, our_tree.as_ref(), &tree)?;
    }
    let mut options = git2::MergeOptions::new();
    repo.merge(&[incoming], Some(&mut options), Some(&mut checkout()))
        .map_err(checkout_error)?;
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(Error::new(
            ErrorKind::Conflict,
            "Git の競合が発生しました。解消してから手動でコミットしてください",
        ));
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "Merge upstream",
        &tree,
        &[&ours, &their],
    )?;
    repo.cleanup_state()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::testdir;
    use std::fs;
    use std::path::Path;

    fn add(repo: &Repository, name: &str, body: &str) -> git2::Oid {
        fs::write(repo.workdir().unwrap().join(name), body).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "tester@example.test").unwrap();
        let parent = find_head(repo)
            .unwrap()
            .map(|h| h.peel_to_commit().unwrap());
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            name,
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn adr0105_i7_fast_forward_and_dirty_worktree() {
        let dir = testdir::fresh("git-pull");
        let repo = super::super::initialize(&dir).unwrap();
        let original = add(&repo, "chapter.gm", "第一稿\n");
        let updated = add(&repo, "chapter.gm", "第二稿\n");
        let base = repo.find_object(original, None).unwrap();
        repo.reset(&base, git2::ResetType::Hard, None).unwrap();
        let branch = current_branch(&repo).unwrap();
        let incoming = repo.find_annotated_commit(updated).unwrap();
        integrate(&repo, &branch, &incoming).unwrap();
        assert_eq!(repo.head().unwrap().target(), Some(updated));
        assert_eq!(
            fs::read_to_string(dir.join("chapter.gm")).unwrap(),
            "第二稿\n"
        );
        fs::write(dir.join("chapter.gm"), "ローカルの変更\n").unwrap();
        assert_eq!(clean(&repo).unwrap_err().kind, ErrorKind::Dirty);
    }
}

#[cfg(test)]
mod transport_tests;
