//! English spelling with macOS's NSSpellChecker (docs/adr/0030): the words a
//! sheet's checks send are answered with those spelled wrong.

/// The words of `words` that the English dictionary does not know.
#[cfg(target_os = "macos")]
pub fn misspelled(words: &[String]) -> Vec<String> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::NSString;
    let checker = NSSpellChecker::sharedSpellChecker();
    let lang = NSString::from_str("en");
    words
        .iter()
        .filter(|w| {
            let s = NSString::from_str(w);
            // SAFETY: a null word count is allowed by the method
            let r = unsafe {
                checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                    &s,
                    0,
                    Some(&lang),
                    false,
                    0,
                    std::ptr::null_mut(),
                )
            };
            r.length > 0
        })
        .cloned()
        .collect()
}

/// Off macOS there is no checker: nothing is reported.
#[cfg(not(target_os = "macos"))]
pub fn misspelled(_words: &[String]) -> Vec<String> {
    Vec::new()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::misspelled;

    #[test]
    fn misspelled_words_are_returned_and_known_ones_are_not() {
        let words: Vec<String> = ["hello", "wrold", "lighthouse", "teh", "it's"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            misspelled(&words),
            vec!["wrold".to_string(), "teh".to_string()]
        );
    }
}
