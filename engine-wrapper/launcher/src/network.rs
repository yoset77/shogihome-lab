//! PC access URL selection (ported from `get_pc_url_config`).
//!
//! Default mode trusts the server's automatic private-IP allowance; strict
//! mode intersects the bind endpoints with the configured allowed origins.

use std::collections::HashMap;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessUrls {
    pub url: String,
    pub allowed: bool,
    pub qr_url: Option<String>,
    pub bind: String,
    pub auto_origins: bool,
}

/// Resolve connection display from raw server values, with parent env winning.
/// Keep runtime boolean semantics separate from the settings form: the server
/// enables strict origins only for the exact string `true` (config.ts).
/// Parent names are case-insensitive on Windows, like Node's `process.env`
/// on the main thread.
pub fn access_urls_from_env(
    file: &HashMap<String, String>,
    parent: &HashMap<String, String>,
    local_ip: &str,
) -> AccessUrls {
    access_urls_from_env_with(file, parent, local_ip, cfg!(windows))
}

/// Same as [`access_urls_from_env`] with an explicit case-sensitivity switch
/// for parent names so Windows behavior is testable on every platform.
pub fn access_urls_from_env_with(
    file: &HashMap<String, String>,
    parent: &HashMap<String, String>,
    local_ip: &str,
    parent_case_insensitive: bool,
) -> AccessUrls {
    use crate::env_codec::parent_lookup_with;
    let value = |key: &str| {
        parent_lookup_with(parent, key, parent_case_insensitive)
            .or_else(|| file.get(key))
            .map(String::as_str)
    };
    let bind = value("BIND_ADDRESS").unwrap_or("0.0.0.0");
    let port = value("PORT")
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(8140);
    let strict = value("DISABLE_AUTO_ALLOWED_ORIGINS") == Some("true");
    let origins: Vec<String> = value("ALLOWED_ORIGINS")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    access_urls(bind, port, strict, &origins, local_ip)
}

/// QR codes are for another device, never for the PC's loopback endpoint.
/// Default mode (`strict == false`) always uses the LAN address. Strict mode
/// only uses it when the LAN URL is explicitly listed in allowed origins;
/// otherwise no QR is shown and the UI explains the custom network setup
/// (Python `customNetworkActive` parity).
pub fn access_urls(
    bind: &str,
    port: u16,
    strict: bool,
    origins: &[String],
    local_ip: &str,
) -> AccessUrls {
    let (url, allowed) = pc_url_config(bind, port, strict, origins, local_ip);
    let lan_ip = local_ip
        .parse::<std::net::IpAddr>()
        .ok()
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified());
    let lan_url = lan_ip.map(|ip| format!("http://{}", std::net::SocketAddr::new(ip, port)));
    let qr_url = if bind != "0.0.0.0" {
        None
    } else if !strict {
        lan_url
    } else {
        match lan_url {
            Some(ref candidate) => {
                let allowed = origins
                    .iter()
                    .any(|o| o.trim_end_matches('/') == candidate.as_str());
                if allowed {
                    lan_url
                } else {
                    None
                }
            }
            None => None,
        }
    };
    AccessUrls {
        url,
        allowed,
        qr_url,
        bind: bind.to_string(),
        auto_origins: !strict,
    }
}

/// Returns `(pc_url, is_allowed)`.
pub fn pc_url_config(
    bind_address: &str,
    server_port: u16,
    disable_auto_origins: bool,
    allowed_origins: &[String],
    local_ip: &str,
) -> (String, bool) {
    let local_endpoints: Vec<String> = if bind_address == "0.0.0.0" {
        vec![
            format!("http://127.0.0.1:{server_port}"),
            format!("http://localhost:{server_port}"),
            format!("http://{local_ip}:{server_port}"),
        ]
    } else if bind_address == "127.0.0.1" {
        vec![
            format!("http://127.0.0.1:{server_port}"),
            format!("http://localhost:{server_port}"),
        ]
    } else {
        vec![format!("http://{bind_address}:{server_port}")]
    };
    if !disable_auto_origins {
        return (local_endpoints[0].clone(), true);
    }
    if allowed_origins.is_empty() {
        return (local_endpoints[0].clone(), false);
    }
    let normalized: Vec<&str> = allowed_origins
        .iter()
        .map(|o| o.trim_end_matches('/'))
        .collect();
    for endpoint in &local_endpoints {
        if normalized.contains(&endpoint.as_str()) {
            return (endpoint.clone(), true);
        }
    }
    // No local endpoint allowed, but the user may rely on a proxy domain.
    (allowed_origins[0].clone(), true)
}

/// Best-effort LAN IP via a UDP socket that never sends (ported from
/// `get_local_ip`). Falls back to loopback.
pub fn local_ip() -> String {
    use std::net::UdpSocket;
    // UDP connect sends nothing; local_addr is the interface address the
    // default route would use — the same trick as the old get_local_ip.
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pc_url_strict_mode_matches_server_for_file_and_parent_values() {
        for (raw, auto_origins) in [
            ("true", false),
            ("1", true),
            ("TRUE", true),
            ("yes", true),
            ("on", true),
            (" true ", true),
            ("false", true),
            ("", true),
        ] {
            for exported in [false, true] {
                let file = HashMap::from([(
                    "DISABLE_AUTO_ALLOWED_ORIGINS".into(),
                    if exported { "true" } else { raw }.into(),
                )]);
                let parent = if exported {
                    HashMap::from([("DISABLE_AUTO_ALLOWED_ORIGINS".into(), raw.into())])
                } else {
                    HashMap::new()
                };
                let urls = access_urls_from_env(&file, &parent, "192.168.1.10");
                assert_eq!(
                    urls.auto_origins, auto_origins,
                    "raw={raw:?}, exported={exported}"
                );
                assert_eq!(urls.allowed, auto_origins);
                assert_eq!(urls.qr_url.is_some(), auto_origins);
            }
        }
    }

    #[test]
    fn windows_style_lowercase_parent_names_override_files() {
        // Windows env names are case-insensitive (like Node's `process.env`
        // on the main thread): a lowercase export must win over the file and
        // drive the displayed URL, exactly as the supervised server sees it.
        let file = HashMap::from([
            ("PORT".into(), "8140".into()),
            ("BIND_ADDRESS".into(), "127.0.0.1".into()),
            ("DISABLE_AUTO_ALLOWED_ORIGINS".into(), "false".into()),
        ]);
        let parent = HashMap::from([
            ("port".into(), "9000".into()),
            ("bind_address".into(), "0.0.0.0".into()),
            ("disable_auto_allowed_origins".into(), "true".into()),
            ("allowed_origins".into(), "http://192.168.1.10:9000".into()),
        ]);
        let urls = access_urls_from_env_with(&file, &parent, "192.168.1.10", true);
        assert_eq!(urls.url, "http://192.168.1.10:9000");
        assert_eq!(urls.qr_url.as_deref(), Some(urls.url.as_str()));
        assert!(urls.allowed);
        assert!(!urls.auto_origins);
        assert_eq!(urls.bind, "0.0.0.0");
        // Case-sensitive (Unix) resolution ignores the lowercase entries.
        let urls = access_urls_from_env_with(&file, &parent, "192.168.1.10", false);
        assert_eq!(urls.url, "http://127.0.0.1:8140");
        assert!(urls.qr_url.is_none());
        assert!(urls.auto_origins);
    }

    #[test]
    fn windows_style_lowercase_parent_port_without_file_key() {
        // No PORT in the file: the inherited lowercase `port` is what the
        // server listens on, so readiness and display must both use it.
        let file = HashMap::new();
        let parent = HashMap::from([("port".into(), "9000".into())]);
        let urls = access_urls_from_env_with(&file, &parent, "192.168.1.10", true);
        assert_eq!(urls.url, "http://127.0.0.1:9000");
        assert_eq!(urls.qr_url.as_deref(), Some("http://192.168.1.10:9000"));
        let urls = access_urls_from_env_with(&file, &parent, "192.168.1.10", false);
        assert_eq!(urls.url, "http://127.0.0.1:8140");
    }

    #[test]
    fn exported_network_values_override_file_values() {
        let file = HashMap::from([
            ("PORT".into(), "8140".into()),
            ("BIND_ADDRESS".into(), "127.0.0.1".into()),
            ("DISABLE_AUTO_ALLOWED_ORIGINS".into(), "false".into()),
            ("ALLOWED_ORIGINS".into(), "http://localhost:8140".into()),
        ]);
        let mut parent = HashMap::from([
            ("PORT".into(), "9000".into()),
            ("BIND_ADDRESS".into(), "0.0.0.0".into()),
            ("DISABLE_AUTO_ALLOWED_ORIGINS".into(), "true".into()),
            ("ALLOWED_ORIGINS".into(), "http://192.168.1.10:9000/".into()),
        ]);
        let urls = access_urls_from_env(&file, &parent, "192.168.1.10");
        assert_eq!(urls.url, "http://192.168.1.10:9000");
        assert_eq!(urls.qr_url.as_deref(), Some(urls.url.as_str()));
        assert!(urls.allowed);
        assert!(!urls.auto_origins);
        assert_eq!(urls.bind, "0.0.0.0");
        parent.remove("BIND_ADDRESS");
        let urls = access_urls_from_env(&file, &parent, "192.168.1.10");
        assert_eq!(urls.bind, "127.0.0.1");
        assert!(urls.qr_url.is_none());
    }

    #[test]
    fn qr_uses_lan_address_and_is_hidden_in_local_or_strict_mode() {
        let urls = access_urls("0.0.0.0", 9000, false, &[], "192.168.1.10");
        assert_eq!(urls.url, "http://127.0.0.1:9000");
        assert_eq!(urls.qr_url.as_deref(), Some("http://192.168.1.10:9000"));
        assert_eq!(urls.bind, "0.0.0.0");
        assert!(urls.auto_origins);
        assert!(access_urls("127.0.0.1", 9000, false, &[], "192.168.1.10")
            .qr_url
            .is_none());
        assert!(access_urls("0.0.0.0", 9000, true, &[], "192.168.1.10")
            .qr_url
            .is_none());
        assert!(access_urls("0.0.0.0", 9000, false, &[], "127.0.0.1")
            .qr_url
            .is_none());
    }

    #[test]
    fn qr_shown_in_strict_mode_only_when_lan_origin_allowed() {
        let allowed = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // LAN URL explicitly allowed: QR is safe to show.
        let urls = access_urls(
            "0.0.0.0",
            9000,
            true,
            &allowed(&["http://192.168.1.10:9000"]),
            "192.168.1.10",
        );
        assert_eq!(urls.qr_url.as_deref(), Some("http://192.168.1.10:9000"));
        assert_eq!(urls.bind, "0.0.0.0");
        assert!(!urls.auto_origins);
        // Trailing slash is normalized.
        let urls = access_urls(
            "0.0.0.0",
            9000,
            true,
            &allowed(&["http://192.168.1.10:9000/"]),
            "192.168.1.10",
        );
        assert_eq!(urls.qr_url.as_deref(), Some("http://192.168.1.10:9000"));
        // Proxy-only origins: no LAN QR (would fail on the phone).
        let urls = access_urls(
            "0.0.0.0",
            9000,
            true,
            &allowed(&["https://shogi.example.com"]),
            "192.168.1.10",
        );
        assert!(urls.qr_url.is_none());
        // Loopback bind never shows a QR, even when allowed.
        let urls = access_urls(
            "127.0.0.1",
            9000,
            true,
            &allowed(&["http://127.0.0.1:9000"]),
            "192.168.1.10",
        );
        assert!(urls.qr_url.is_none());
    }

    #[test]
    fn default_mode_endpoints() {
        assert_eq!(
            pc_url_config("0.0.0.0", 8140, false, &[], "192.168.1.10"),
            ("http://127.0.0.1:8140".to_string(), true)
        );
        assert_eq!(
            pc_url_config("192.168.1.10", 8140, false, &[], "192.168.1.10"),
            ("http://192.168.1.10:8140".to_string(), true)
        );
    }

    #[test]
    fn strict_mode_selection() {
        let allowed = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            pc_url_config(
                "0.0.0.0",
                8140,
                true,
                &allowed(&["http://192.168.1.10:8140"]),
                "192.168.1.10"
            ),
            ("http://192.168.1.10:8140".to_string(), true)
        );
        // Trailing slashes are normalized.
        assert_eq!(
            pc_url_config(
                "0.0.0.0",
                8140,
                true,
                &allowed(&["http://127.0.0.1:8140/"]),
                "192.168.1.10"
            ),
            ("http://127.0.0.1:8140".to_string(), true)
        );
        // Proxy-only origins fall back to the first allowed origin.
        assert_eq!(
            pc_url_config(
                "0.0.0.0",
                8140,
                true,
                &allowed(&["https://shogi.example.com"]),
                "192.168.1.10"
            ),
            ("https://shogi.example.com".to_string(), true)
        );
        // Strict with no origins: blocked.
        assert_eq!(
            pc_url_config("0.0.0.0", 8140, true, &[], "192.168.1.10"),
            ("http://127.0.0.1:8140".to_string(), false)
        );
    }
}
