//! Skip-installed detection — diffs exported log against game's weidu.log.

use super::Component;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Find the WeiDU.log file in a game directory (case-insensitive).
/// WeiDU creates `WeiDU.log` but the case may vary. On Linux, this matters.
pub fn find_weidu_log(game_dir: &Path) -> PathBuf {
    // Try known names first (fast path)
    for name in &["WeiDU.log", "weidu.log", "WEIDU.LOG", "Weidu.log"] {
        let path = game_dir.join(name);
        if path.exists() { return path; }
    }
    // Fallback: case-insensitive directory scan
    if let Ok(entries) = std::fs::read_dir(game_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("weidu.log") {
                return entry.path();
            }
        }
    }
    // Default to WeiDU's actual output name
    game_dir.join("WeiDU.log")
}

/// Parse a WeiDU.log file into Component entries.
pub fn parse_weidu_log(path: &Path) -> Result<Vec<Component>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let mut components = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        if let Some(comp) = parse_log_line(trimmed) {
            components.push(comp);
        }
    }
    Ok(components)
}

/// Parse a single WeiDU.log line: `~path/mod.tp2~ #lang #comp // Name : Version`
fn parse_log_line(line: &str) -> Option<Component> {
    if !line.starts_with('~') {
        return None;
    }
    let parts: Vec<&str> = line.splitn(2, '~').skip(1).collect();
    if parts.is_empty() {
        return None;
    }
    let path_and_rest = parts[0];
    let (tp2_path, rest) = path_and_rest.split_once('~')?;

    // Extract tp_file and mod_name from path
    let normalized = tp2_path.replace('\\', "/");
    let path_parts: Vec<&str> = normalized.split('/').collect();
    let tp_file = path_parts.last()?.to_string();
    // Strip extension first, then prefix, all case-insensitive
    let without_ext = if tp_file.to_lowercase().ends_with(".tp2") {
        &tp_file[..tp_file.len() - 4]
    } else {
        &tp_file
    };
    let without_prefix = if without_ext.to_lowercase().starts_with("setup-") {
        &without_ext[6..]
    } else {
        without_ext
    };
    let mod_name = without_prefix.to_lowercase();

    // Parse #lang #comp
    let rest = rest.trim();
    let mut nums = Vec::new();
    for token in rest.split_whitespace() {
        if token.starts_with('#') {
            if let Ok(n) = token[1..].parse::<u32>() {
                nums.push(n);
            }
        } else if token == "//" {
            break;
        }
    }

    let lang = *nums.first().unwrap_or(&0);
    let component = *nums.get(1).unwrap_or(&0);

    // Parse component name from comment
    let comment = if let Some(idx) = rest.find("//") {
        rest[idx + 2..].trim().to_string()
    } else {
        String::new()
    };

    // Extract version from last colon (only if it looks like a version)
    let component_name = if let Some(idx) = comment.rfind(':') {
        let candidate = comment[idx + 1..].trim();
        if candidate.len() <= 20 && candidate.starts_with(|c: char| c.is_ascii_digit() || c == 'v') {
            comment[..idx].trim().to_string()
        } else {
            comment.clone()
        }
    } else {
        comment
    };

    Some(Component {
        tp_file,
        mod_name,
        lang,
        component,
        component_name,
    })
}

/// Filter out components that are already installed in the game's weidu.log.
pub fn filter_already_installed(
    to_install: &[Component],
    game_dir: &Path,
) -> Vec<Component> {
    let game_log = find_weidu_log(game_dir);
    let installed = parse_weidu_log(&game_log).unwrap_or_default();

    // Build set of installed (tp_file_lower, component) pairs
    let installed_set: HashSet<(String, u32)> = installed
        .iter()
        .map(|c| (c.tp_file.to_lowercase(), c.component))
        .collect();

    to_install
        .iter()
        .filter(|c| !installed_set.contains(&(c.tp_file.to_lowercase(), c.component)))
        .cloned()
        .collect()
}

/// Check if a specific component is installed in the game's weidu.log.
/// NOTE: Re-parses the entire log on every call. For batch checks, use `installed_set_from_game`.
pub fn is_component_installed(game_dir: &Path, tp_file: &str, component: u32) -> bool {
    let game_log = find_weidu_log(game_dir);
    let installed = parse_weidu_log(&game_log).unwrap_or_default();
    installed.iter().any(|c| {
        c.tp_file.eq_ignore_ascii_case(tp_file) && c.component == component
    })
}

/// Parse the game's weidu.log once and return a HashSet for fast repeated lookups.
pub fn installed_set_from_game(game_dir: &Path) -> HashSet<(String, u32)> {
    let game_log = find_weidu_log(game_dir);
    let installed = parse_weidu_log(&game_log).unwrap_or_default();
    installed.iter()
        .map(|c| (c.tp_file.to_lowercase(), c.component))
        .collect()
}

/// Check a component against a pre-parsed installed set.
pub fn is_in_installed_set(set: &HashSet<(String, u32)>, tp_file: &str, component: u32) -> bool {
    set.contains(&(tp_file.to_lowercase(), component))
}
