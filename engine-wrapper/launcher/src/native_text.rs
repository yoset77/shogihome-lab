//! Native messages are embedded from the shared i18n resources. Before a
//! WebView exists, POSIX locale variables select Japanese, with English fallback.
use std::sync::LazyLock;

static MESSAGES: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../shogihome/src/common/i18n/launcher-native.json"
    ))
    .expect("native message resources must be valid JSON")
});

pub fn text(key: &str) -> &'static str {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
        .unwrap_or_default();
    let lang = if locale.to_ascii_lowercase().starts_with("ja") {
        "ja"
    } else {
        "en"
    };
    MESSAGES[lang][key]
        .as_str()
        .expect("native message key must exist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_native_message_has_both_translations() {
        let ja = MESSAGES["ja"].as_object().unwrap();
        let en = MESSAGES["en"].as_object().unwrap();
        assert_eq!(ja.len(), en.len());
        for key in en.keys() {
            assert!(!ja[key].as_str().unwrap().is_empty());
            assert!(!en[key].as_str().unwrap().is_empty());
        }
    }
}
