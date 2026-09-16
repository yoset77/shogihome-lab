//! PC access URL selection (ported from `get_pc_url_config`).
//!
//! Default mode trusts the server's automatic private-IP allowance; strict
//! mode intersects the bind endpoints with the configured allowed origins.

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessUrls {
    pub url: String,
    pub allowed: bool,
    pub qr_url: Option<String>,
    pub bind: String,
    pub auto_origins: bool,
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
