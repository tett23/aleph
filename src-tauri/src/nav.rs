//! Where windows may go and what opens in the browser (docs/adr/0044).

/// Whether a window may navigate to `url`: the app's own pages (and the dev
/// server while developing), and the blob and about pages they make.
pub fn navigation_allowed(url: &str, dev: Option<&str>) -> bool {
    let own = ["tauri://localhost", "http://tauri.localhost"];
    let under = |base: &str, u: &str| {
        let base = base.trim_end_matches('/');
        u == base || u.starts_with(&format!("{base}/")) || u.starts_with(&format!("{base}?"))
    };
    own.iter().any(|b| under(b, url))
        || dev.is_some_and(|d| under(d, url))
        || url.starts_with("blob:")
        || url == "about:blank"
}

/// The URL to give the browser: http and https with a host, nothing else.
pub fn web_url(s: &str) -> Option<String> {
    let u = tauri::Url::parse(s.trim()).ok()?;
    (matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()))
        .then(|| u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_pages_and_the_dev_server_are_allowed() {
        let dev = Some("http://localhost:1420");
        assert!(navigation_allowed("tauri://localhost", None));
        assert!(navigation_allowed(
            "tauri://localhost/index.html?view=plot",
            None
        ));
        assert!(navigation_allowed("http://localhost:1420/index.html", dev));
        assert!(navigation_allowed("blob:tauri://localhost/1234", None));
        assert!(
            !navigation_allowed("http://localhost:1420/", None),
            "no dev server in a build"
        );
        assert!(!navigation_allowed("http://localhost:14200/", dev));
        assert!(!navigation_allowed("tauri://localhost.evil.example/", None));
        assert!(!navigation_allowed("https://example.com/", dev));
        assert!(!navigation_allowed("file:///etc/passwd", dev));
        assert!(!navigation_allowed("javascript:alert(1)", dev));
    }

    #[test]
    fn only_http_and_https_open_in_the_browser() {
        assert_eq!(
            web_url(" https://example.com/a?b=1 ").as_deref(),
            Some("https://example.com/a?b=1")
        );
        assert_eq!(
            web_url("http://example.com").as_deref(),
            Some("http://example.com/")
        );
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@example.com",
            "-a",
            "/Applications/Calculator.app",
            "https://",
            "smb://host/share",
        ] {
            assert_eq!(web_url(bad), None, "{bad}");
        }
    }
}
