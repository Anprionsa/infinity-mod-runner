//! Parser for the BCS buffer cache stats line that the patched WeiDU emits
//! on stderr at process exit.
//!
//! Emitter: `weidu_src/src/bcs_buffer_cache.ml` at_exit handler. The cache
//! emits two lines on exit:
//!
//! 1. `BCS_CACHE_STATS_JSON {...}` — always emitted (even when disabled or
//!    cold). This is the stable wire format this module parses. Fields
//!    can be added in future revisions; serde's tolerant deserialization
//!    keeps older parsers working as long as the existing field set stays
//!    present with matching types.
//!
//! 2. `BCS buffer cache: N hits / M misses ...` — human-readable summary,
//!    only when the cache saw traffic. Not parsed here; goes straight to
//!    the stderr stream for developer tail debugging.
//!
//! Emission is inside OCaml's `at_exit`, which only runs on clean shutdown.
//! A segfault or abort skips both lines — so a missing `install:bcs_cache_stats`
//! event is a signal that WeiDU died hard, not that the cache was unused.
//!
//! ## Error handling
//!
//! `try_parse_line` returns a three-state `Option<Result>`:
//! - `None` — the line doesn't have the JSON prefix; ignore.
//! - `Some(Ok(stats))` — parsed cleanly; emit the structured event.
//! - `Some(Err(err))` — prefix matched but body was malformed. The caller
//!   should emit a diagnostic event so format drift is caught loudly
//!   instead of silently dropping stats.

use serde::{Deserialize, Serialize};

/// Stable prefix that tags the machine-readable emission. Must match
/// `bcs_buffer_cache.ml`'s `at_exit` handler. A trailing space separates
/// the prefix from the JSON body.
pub const WIRE_PREFIX: &str = "BCS_CACHE_STATS_JSON ";

/// Parsed stats from one WeiDU invocation's cache report.
///
/// `#[serde(default)]` on optional fields so future OCaml revisions that
/// add new fields don't break older Rust parsers, and older emissions
/// missing future fields still deserialize with sensible defaults.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BcsCacheStats {
    /// False when `WEIDU_BCS_CACHE_MB=0` or the cache was otherwise
    /// turned off. Lets the frontend distinguish intentional disable
    /// (A/B baseline) from a cold run where nothing touched BCS.
    pub enabled: bool,
    pub hits: u64,
    pub misses: u64,
    pub hit_rate_pct: f64,
    pub evictions: u64,
    pub peak_kb: u64,
    /// Bytes currently held in the cache at exit (divided by 1024). Not
    /// the same as peak — cache may have shed entries via LRU eviction
    /// before the end.
    #[serde(default)]
    pub current_kb: u64,
    /// Configured byte budget in MB (i.e. the effective
    /// `WEIDU_BCS_CACHE_MB` value — 0 when disabled, 256 by default).
    #[serde(default)]
    pub max_mb: u64,
}

impl BcsCacheStats {
    /// Total lookups = hits + misses. Zero on a disabled or cold run.
    pub fn total_lookups(&self) -> u64 {
        self.hits + self.misses
    }
}

/// Malformed-body error. Carries the offending payload so the caller can
/// include it in a diagnostic event for debugging format drift.
#[derive(Debug, Clone)]
pub struct CacheLineParseError {
    /// The JSON body that failed to deserialize (the text after the prefix).
    pub raw_body: String,
    /// Serde's error message.
    pub reason: String,
}

/// Try to parse a single stderr line.
///
/// - `None` if the line doesn't start with `WIRE_PREFIX` — not a cache line.
/// - `Some(Ok(stats))` on successful parse.
/// - `Some(Err(...))` if the prefix matched but the JSON body failed —
///   caller should treat this as a format-drift alarm, not a silent drop.
pub fn try_parse_line(line: &str) -> Option<Result<BcsCacheStats, CacheLineParseError>> {
    let body = line.strip_prefix(WIRE_PREFIX)?;
    Some(
        serde_json::from_str::<BcsCacheStats>(body).map_err(|e| CacheLineParseError {
            raw_body: body.to_string(),
            reason: e.to_string(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_line() -> String {
        // Mirrors the OCaml Printf format verbatim.
        r#"BCS_CACHE_STATS_JSON {"enabled":true,"hits":12345,"misses":678,"hit_rate_pct":94.8,"evictions":9,"peak_kb":123,"current_kb":100,"max_mb":256}"#
            .to_string()
    }

    #[test]
    fn parse_canonical_line() {
        let out = try_parse_line(&canonical_line()).expect("prefix matches");
        let s = out.expect("body parses");
        assert!(s.enabled);
        assert_eq!(s.hits, 12345);
        assert_eq!(s.misses, 678);
        assert!((s.hit_rate_pct - 94.8).abs() < 0.01);
        assert_eq!(s.evictions, 9);
        assert_eq!(s.peak_kb, 123);
        assert_eq!(s.current_kb, 100);
        assert_eq!(s.max_mb, 256);
        assert_eq!(s.total_lookups(), 13_023);
    }

    #[test]
    fn parse_disabled_cache() {
        // Emitted when WEIDU_BCS_CACHE_MB=0 — everything zero but enabled=false.
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":false,"hits":0,"misses":0,"hit_rate_pct":0.0,"evictions":0,"peak_kb":0,"current_kb":0,"max_mb":0}"#;
        let out = try_parse_line(line).expect("prefix matches");
        let s = out.expect("body parses");
        assert!(!s.enabled);
        assert_eq!(s.total_lookups(), 0);
        assert_eq!(s.max_mb, 0);
    }

    #[test]
    fn parse_cold_run() {
        // Enabled but never hit — cache patched in, but workload didn't touch BCS.
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":true,"hits":0,"misses":0,"hit_rate_pct":0.0,"evictions":0,"peak_kb":0,"current_kb":0,"max_mb":256}"#;
        let out = try_parse_line(line).expect("prefix matches");
        let s = out.expect("body parses");
        assert!(s.enabled);
        assert_eq!(s.total_lookups(), 0);
        assert_eq!(s.max_mb, 256);
    }

    #[test]
    fn parse_perfect_hit_rate() {
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":true,"hits":999999,"misses":1,"hit_rate_pct":100.0,"evictions":8123,"peak_kb":262144,"current_kb":131072,"max_mb":256}"#;
        let out = try_parse_line(line).expect("prefix matches");
        let s = out.expect("body parses");
        assert_eq!(s.hits, 999_999);
        assert_eq!(s.total_lookups(), 1_000_000);
        assert_eq!(s.peak_kb, 262_144);
    }

    #[test]
    fn forward_compat_future_fields() {
        // Future OCaml revision adds a new field the current Rust doesn't know
        // about. serde_json's default is to silently ignore unknown fields, so
        // parsing should still succeed.
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":true,"hits":5,"misses":5,"hit_rate_pct":50.0,"evictions":0,"peak_kb":1,"current_kb":1,"max_mb":128,"future_field":"something"}"#;
        let out = try_parse_line(line).expect("prefix matches");
        let s = out.expect("body parses");
        assert_eq!(s.hits, 5);
    }

    #[test]
    fn backward_compat_missing_optional_fields() {
        // Older emitter that didn't yet include current_kb / max_mb. Still parses,
        // with defaults for the missing fields.
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":true,"hits":5,"misses":5,"hit_rate_pct":50.0,"evictions":0,"peak_kb":1}"#;
        let out = try_parse_line(line).expect("prefix matches");
        let s = out.expect("body parses");
        assert_eq!(s.hits, 5);
        assert_eq!(s.current_kb, 0);
        assert_eq!(s.max_mb, 0);
    }

    #[test]
    fn non_matching_prefix_returns_none() {
        assert!(try_parse_line("").is_none());
        assert!(try_parse_line("WARNING: something else").is_none());
        assert!(try_parse_line("BCS buffer cache: 5 hits / 5 misses ...").is_none());
        // Trailing space missing
        assert!(try_parse_line(r#"BCS_CACHE_STATS_JSON{"enabled":true}"#).is_none());
    }

    #[test]
    fn prefix_match_bad_json_returns_error() {
        // Prefix matches but body is garbage — must surface as Err, not None,
        // so the caller can emit a diagnostic instead of silently dropping.
        let line = "BCS_CACHE_STATS_JSON not-json-at-all";
        match try_parse_line(line) {
            Some(Err(e)) => {
                assert_eq!(e.raw_body, "not-json-at-all");
                assert!(!e.reason.is_empty());
            }
            other => panic!("expected Some(Err(...)), got {other:?}"),
        }
    }

    #[test]
    fn prefix_match_missing_required_field_returns_error() {
        // hits is required (no #[serde(default)]), so omitting it must error.
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":true,"misses":5,"hit_rate_pct":0.0,"evictions":0,"peak_kb":0}"#;
        match try_parse_line(line) {
            Some(Err(e)) => {
                assert!(e.reason.contains("hits"), "error should mention missing field: {}", e.reason);
            }
            other => panic!("expected Some(Err(...)), got {other:?}"),
        }
    }

    #[test]
    fn prefix_match_wrong_type_returns_error() {
        let line = r#"BCS_CACHE_STATS_JSON {"enabled":"yes","hits":0,"misses":0,"hit_rate_pct":0.0,"evictions":0,"peak_kb":0}"#;
        match try_parse_line(line) {
            Some(Err(_)) => {}
            other => panic!("expected Some(Err(...)), got {other:?}"),
        }
    }

    #[test]
    fn serializes_as_flat_json() {
        let s = BcsCacheStats {
            enabled: true,
            hits: 10,
            misses: 2,
            hit_rate_pct: 83.3,
            evictions: 0,
            peak_kb: 512,
            current_kb: 400,
            max_mb: 128,
        };
        let json = serde_json::to_value(&s).expect("serializes");
        assert_eq!(json["enabled"], true);
        assert_eq!(json["hits"], 10);
        assert_eq!(json["misses"], 2);
        assert_eq!(json["max_mb"], 128);
        assert!((json["hit_rate_pct"].as_f64().unwrap() - 83.3).abs() < 0.01);
    }
}
