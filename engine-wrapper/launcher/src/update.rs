//! Update notification (check only, never auto-install).
//!
//! Ported from `update_checker.py`: bundled-only execution, `VERSION` file,
//! 5s GitHub request, highest eligible release, prerelease-channel rule
//! (prereleases considered only when current is a prerelease), 7-day snooze
//! with newer-version bypass, cached UI language.
//!
//! Version comparison implements the needed `packaging` subset locally:
//! leading `v` tolerated; `1.17.0-alpha.0` equals legacy `1.17.0a0` (old
//! snooze files may contain the normalized form); release > prerelease.

use std::path::Path;
use std::time::Duration;

use crate::error::LauncherError;

pub const DEFAULT_REPO_OWNER: &str = "yoset77";
pub const DEFAULT_REPO_NAME: &str = "shogihome-lab";
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
pub const SNOOZE_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub tag: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpdateCache {
    pub snoozed_version: Option<String>,
    pub snoozed_until_unix: Option<i64>,
    pub ui_language: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum PreKind {
    Alpha,
    Beta,
    Rc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: Vec<u64>,
    pre: Option<(PreKind, Vec<u64>)>,
}

impl Version {
    pub fn is_prerelease(&self) -> bool {
        self.pre.is_some()
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let len = self.core.len().max(other.core.len());
        for i in 0..len {
            let a = self.core.get(i).copied().unwrap_or(0);
            let b = other.core.get(i).copied().unwrap_or(0);
            match a.cmp(&b) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }
        }
        match (&self.pre, &other.pre) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some((ka, na)), Some((kb, nb))) => match ka.cmp(kb) {
                std::cmp::Ordering::Equal => {
                    let len = na.len().max(nb.len());
                    for i in 0..len {
                        match na
                            .get(i)
                            .copied()
                            .unwrap_or(0)
                            .cmp(&nb.get(i).copied().unwrap_or(0))
                        {
                            std::cmp::Ordering::Equal => {}
                            ord => return ord,
                        }
                    }
                    std::cmp::Ordering::Equal
                }
                ord => ord,
            },
        }
    }
}

/// Parse a version, tolerating a leading `v` and legacy `1.17.0a0` style.
pub fn parse_version(s: &str) -> Option<Version> {
    let s = s
        .strip_prefix('v')
        .or_else(|| s.strip_prefix('V'))
        .unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    let (core_part, pre_part) = split_pre(s)?;
    let core: Vec<u64> = core_part
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    if core.is_empty() || core.len() > 4 {
        return None;
    }
    let pre = match pre_part {
        None => None,
        Some(pre) => Some(parse_pre(&pre)?),
    };
    Some(Version { core, pre })
}

/// Normalized display matching `packaging` (`1.2.0-beta.2` → `1.2.0b2`).
pub fn display_version(v: &Version) -> String {
    let mut out = v
        .core
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(".");
    if let Some((kind, nums)) = &v.pre {
        let tag = match kind {
            PreKind::Alpha => "a",
            PreKind::Beta => "b",
            PreKind::Rc => "rc",
        };
        out.push_str(tag);
        out.push_str(
            &nums
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join("."),
        );
    }
    out
}

fn split_pre(s: &str) -> Option<(String, Option<String>)> {
    // Explicit '-' separator first (semver/packaging style).
    if let Some(idx) = s.find('-') {
        let (core, pre) = s.split_at(idx);
        if core.is_empty() || pre.len() < 2 {
            return None;
        }
        return Some((core.to_string(), Some(pre[1..].to_string())));
    }
    // Legacy attached suffix: trailing [alpha run][digit run], e.g. the
    // "a0" in "1.17.0a0". A plain core ("1.2.3") has no alpha run.
    let bytes = s.as_bytes();
    let mut digit_start = s.len();
    while digit_start > 0 && bytes[digit_start - 1].is_ascii_digit() {
        digit_start -= 1;
    }
    let mut mark_start = digit_start;
    while mark_start > 0 && bytes[mark_start - 1].is_ascii_alphabetic() {
        mark_start -= 1;
    }
    if mark_start == digit_start {
        return Some((s.to_string(), None));
    }
    let (core, rest) = s.split_at(mark_start);
    let (mark, tail) = rest.split_at(digit_start - mark_start);
    if core.is_empty() || !core.as_bytes()[core.len() - 1].is_ascii_digit() {
        return None;
    }
    if !["a", "alpha", "b", "beta", "rc"].contains(&mark.to_lowercase().as_str()) {
        return None;
    }
    let mut pre = mark.to_string();
    pre.push_str(tail);
    Some((core.trim_end_matches('.').to_string(), Some(pre)))
}

fn parse_pre(pre: &str) -> Option<(PreKind, Vec<u64>)> {
    let lower = pre.to_lowercase();
    // Split leading marker letters from the numeric tail.
    let mut idx = 0;
    while idx < lower.len() && lower.as_bytes()[idx].is_ascii_alphabetic() {
        idx += 1;
    }
    let (mark, tail) = lower.split_at(idx);
    let kind = match mark {
        "a" | "alpha" => PreKind::Alpha,
        "b" | "beta" => PreKind::Beta,
        "rc" => PreKind::Rc,
        _ => return None,
    };
    let tail = tail.trim_start_matches(['.', '-', '_']);
    let nums = if tail.is_empty() {
        Vec::new()
    } else {
        tail.split(['.', '-', '_'])
            .map(|p| p.parse::<u64>().ok())
            .collect::<Option<_>>()?
    };
    Some((kind, nums))
}

/// Select the highest eligible release newer than `current_version` from a
/// GitHub releases JSON payload. Drafts always skipped; prereleases skipped
/// unless current itself is a prerelease.
pub fn select_best_release(current_version: &str, releases_json: &str) -> Option<UpdateInfo> {
    let current = parse_version(current_version)?;
    let releases: Vec<serde_json::Value> = serde_json::from_str(releases_json).ok()?;
    let include_prerelease = current.is_prerelease();
    let mut best: Option<(Version, UpdateInfo)> = None;
    for release in &releases {
        if release
            .get("draft")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if !include_prerelease
            && release
                .get("prerelease")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(version) = parse_version(tag) else {
            continue;
        };
        if version > current && best.as_ref().map(|(v, _)| &version > v).unwrap_or(true) {
            let url = release
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            best = Some((
                version.clone(),
                UpdateInfo {
                    version: display_version(&version),
                    tag: tag.to_string(),
                    url,
                },
            ));
        }
    }
    best.map(|(_, info)| info)
}

/// Read the bundled version from a VERSION file.
pub fn load_current_version(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Fetch the releases JSON from GitHub (5s timeout, UA header).
pub fn fetch_releases_json(
    owner: &str,
    repo: &str,
    current_version: &str,
) -> Result<String, LauncherError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=20");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(FETCH_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(&url)
        .header("User-Agent", &format!("ShogiHomeLab/{current_version}"))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| LauncherError::msg(format!("update check request failed: {e}")))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|e| LauncherError::msg(format!("update check response failed: {e}")))
}

/// Check for updates. `fetch` is injectable for tests; production passes
/// [`fetch_releases_json`].
pub fn check_for_update(
    current_version: &str,
    cache: &UpdateCache,
    now_unix: i64,
    fetch: impl FnOnce() -> Result<String, LauncherError>,
) -> Result<Option<UpdateInfo>, LauncherError> {
    let payload = fetch()?;
    let info = select_best_release(current_version, &payload);
    Ok(info.filter(|i| !is_snoozed(cache, &i.version, now_unix)))
}

/// The production entry point reads the same cache written by the snooze IPC.
pub fn check_bundled_update(
    config_dir: &Path,
    fetch: impl FnOnce(&str) -> Result<String, LauncherError>,
) -> Result<Option<UpdateInfo>, LauncherError> {
    let current = load_current_version(&config_dir.join("VERSION")).ok_or("no VERSION file")?;
    let cache = UpdateCache::load(&config_dir.join(".update_cache.json"));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| LauncherError::msg(e.to_string()))?
        .as_secs() as i64;
    check_for_update(&current, &cache, now, || fetch(&current))
}

pub fn is_snoozed(cache: &UpdateCache, version: &str, now_unix: i64) -> bool {
    let (Some(snoozed), Some(until)) = (cache.snoozed_version.as_deref(), cache.snoozed_until_unix)
    else {
        return false;
    };
    let (Some(snoozed_v), Some(v)) = (parse_version(snoozed), parse_version(version)) else {
        return false;
    };
    if v > snoozed_v {
        return false;
    }
    now_unix < until
}

pub fn snooze(cache: &mut UpdateCache, version: &str, now_unix: i64) {
    cache.snoozed_version = Some(version.to_string());
    cache.snoozed_until_unix = Some(now_unix + SNOOZE_DAYS * 86_400);
}

const CACHE_VERSION: u32 = 1;

impl UpdateCache {
    pub fn load(path: &Path) -> Self {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return Self::default(),
        };
        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return Self::default(),
        };
        // Tolerate both ISO-8601 (Python cache) and unix timestamps.
        let until_unix = value
            .get("snoozed_until")
            .and_then(|v| v.as_i64())
            .or_else(|| {
                value
                    .get("snoozed_until")
                    .and_then(|v| v.as_str())
                    .and_then(parse_iso_unix)
            });
        Self {
            snoozed_version: value
                .get("snoozed_version")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            snoozed_until_unix: until_unix,
            ui_language: value
                .get("ui_language")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), LauncherError> {
        let value = serde_json::json!({
            "cache_version": CACHE_VERSION,
            "snoozed_version": self.snoozed_version,
            "snoozed_until": self.snoozed_until_unix,
            "ui_language": self.ui_language,
        });
        let content = serde_json::to_string(&value)
            .map_err(|e| LauncherError::json("serializing update cache".to_string(), e))?;
        shogihome_env_file::write_atomic(path, content.as_bytes())
            .map_err(|e| LauncherError::io(format!("writing {}", path.display()), e))
    }
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.frac][+HH:MM|Z]` to unix seconds (for old
/// Python-written caches). Best-effort civil-date math, no dependencies.
fn parse_iso_unix(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    // Split time from timezone suffix.
    let t_end = time.find(['+', '-', 'Z']).unwrap_or(time.len());
    let (t, tz) = time.split_at(t_end);
    let mut parts = t.split(':');
    let (hh, mm): (i64, i64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    let ss: i64 = parts
        .next()
        .and_then(|p| p.split('.').next())
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    let days = days_from_civil(y, m, day)?;
    let mut unix = days * 86_400 + hh * 3600 + mm * 60 + ss;
    if tz == "Z" || tz.is_empty() {
        // UTC already.
    } else {
        let (sign, off) = tz
            .strip_prefix('+')
            .map(|o| (-1, o))
            .or_else(|| tz.strip_prefix('-').map(|o| (1, o)))?;
        let (oh, om) = off.split_once(':').unwrap_or((off, "00"));
        let delta: i64 = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
        unix += sign * delta;
    }
    Some(unix)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_matches_packaging_subset() {
        assert_eq!(display_version(&parse_version("v1.2.3").unwrap()), "1.2.3");
        assert_eq!(parse_version("1.17.0-alpha.0"), parse_version("1.17.0a0"));
        assert!(parse_version("invalid").is_none());
        assert!(parse_version("").is_none());
        assert!(parse_version("1.2.0-beta.2") > parse_version("1.2.0-beta.1"));
        assert!(parse_version("1.2.0") > parse_version("1.2.0-rc.9"));
    }

    #[test]
    fn update_info_serializes_for_ipc() {
        // Tauri commands require Serialize on custom return types
        // (`check_update` returns Option<UpdateInfo>).
        let info = UpdateInfo {
            version: "1.2.0".to_string(),
            tag: "v1.2.0".to_string(),
            url: "u/1.2.0".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({"version": "1.2.0", "tag": "v1.2.0", "url": "u/1.2.0"})
        );
    }

    #[test]
    fn selection_rules() {
        let releases = serde_json::json!([
            {"tag_name": "v1.0.0", "draft": false, "prerelease": false, "html_url": "u/1.0.0"},
            {"tag_name": "v1.2.0", "draft": false, "prerelease": false, "html_url": "u/1.2.0"},
            {"tag_name": "v1.1.0", "draft": false, "prerelease": false, "html_url": "u/1.1.0"},
        ]);
        let info = select_best_release("1.0.0", &releases.to_string()).unwrap();
        assert_eq!(
            (info.tag.as_str(), info.version.as_str()),
            ("v1.2.0", "1.2.0")
        );
        assert!(select_best_release("1.0.0", "[]").is_none());
        assert!(select_best_release("not-a-version", &releases.to_string()).is_none());

        let mixed = serde_json::json!([
            {"tag_name": "v1.2.0-beta", "draft": false, "prerelease": true, "html_url": "u/b"},
            {"tag_name": "v9.9.9-draft", "draft": true, "prerelease": false, "html_url": "u/d"},
            {"tag_name": "v1.1.0", "draft": false, "prerelease": false, "html_url": "u/1.1.0"},
        ]);
        assert_eq!(
            select_best_release("1.0.0", &mixed.to_string())
                .unwrap()
                .tag,
            "v1.1.0"
        );

        let pres = serde_json::json!([
            {"tag_name": "v1.2.0-beta.2", "draft": false, "prerelease": true, "html_url": "u/b2"},
            {"tag_name": "v1.1.0", "draft": false, "prerelease": false, "html_url": "u/1.1.0"},
        ]);
        assert_eq!(
            select_best_release("1.2.0-beta.1", &pres.to_string())
                .unwrap()
                .tag,
            "v1.2.0-beta.2"
        );
    }

    #[test]
    fn unparsable_tags_are_skipped_not_fatal() {
        // A nightly-style tag before AND after the valid candidate must not
        // discard the whole notification (old `?` returned None entirely).
        let releases = serde_json::json!([
            {"tag_name": "nightly", "draft": false, "prerelease": false, "html_url": "u/n"},
            {"tag_name": "v1.2.0", "draft": false, "prerelease": false, "html_url": "u/1.2.0"},
            {"tag_name": "not-a-version", "draft": false, "prerelease": false, "html_url": "u/x"},
            {"tag_name": null, "draft": false, "prerelease": false, "html_url": "u/null"},
        ]);
        let info = select_best_release("1.0.0", &releases.to_string()).unwrap();
        assert_eq!(
            (info.tag.as_str(), info.version.as_str()),
            ("v1.2.0", "1.2.0")
        );
        // Only unparsable candidates → no update, not a crash.
        let junk = serde_json::json!([
            {"tag_name": "nightly", "draft": false, "prerelease": false, "html_url": "u/n"},
        ]);
        assert!(select_best_release("1.0.0", &junk.to_string()).is_none());
    }

    #[test]
    fn snooze_and_cache_round_trip() {
        let mut cache = UpdateCache::default();
        let now = 1_786_000_000i64;
        snooze(&mut cache, "1.2.0", now);
        assert!(is_snoozed(&cache, "1.2.0", now + 86_400));
        assert!(!is_snoozed(&cache, "1.2.0", now + 8 * 86_400));
        assert!(!is_snoozed(&cache, "1.3.0", now + 86_400));

        let dir = std::env::temp_dir().join(format!("upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cache.json");
        cache.ui_language = Some("en".to_string());
        cache.save(&path).unwrap();
        let loaded = UpdateCache::load(&path);
        assert!(is_snoozed(&loaded, "1.2.0", now + 86_400));
        assert_eq!(loaded.ui_language.as_deref(), Some("en"));
        // Corrupt file → empty cache.
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(UpdateCache::load(&path), UpdateCache::default());
        // Legacy Python ISO-8601 cache still parses.
        std::fs::write(&path, br#"{"snoozed_version": "1.17.0a0", "snoozed_until": "2026-01-08T12:00:00+00:00", "ui_language": null}"#).unwrap();
        let legacy = UpdateCache::load(&path);
        assert!(is_snoozed(&legacy, "1.17.0a0", 1_767_225_600));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn version_file_loading() {
        let dir = std::env::temp_dir().join(format!("updv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("VERSION");
        std::fs::write(&path, "1.2.3\n").unwrap();
        assert_eq!(load_current_version(&path).as_deref(), Some("1.2.3"));
        assert!(load_current_version(&dir.join("missing")).is_none());
        std::fs::write(&path, "   \n").unwrap();
        assert!(load_current_version(&path).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundled_check_honors_persisted_snooze_but_shows_newer_release() {
        let dir = std::env::temp_dir().join(format!("bundled-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("VERSION"), "1.0.0").unwrap();
        let cache = UpdateCache {
            snoozed_version: Some("1.1.0".into()),
            snoozed_until_unix: Some(i64::MAX),
            ui_language: None,
        };
        cache.save(&dir.join(".update_cache.json")).unwrap();
        let fetch = |tag| {
            Ok(
                serde_json::json!([{ "tag_name": tag, "html_url": "https://example.com" }])
                    .to_string(),
            )
        };
        assert!(check_bundled_update(&dir, |_| fetch("v1.1.0"))
            .unwrap()
            .is_none());
        assert_eq!(
            check_bundled_update(&dir, |_| fetch("v1.2.0"))
                .unwrap()
                .unwrap()
                .tag,
            "v1.2.0"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
