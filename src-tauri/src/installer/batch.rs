//! Component batching — groups consecutive components from the same mod into batches.

use super::{Batch, Component, FORCE_SMALL_BATCH_MODS, FORCE_SMALL_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE};
use std::collections::HashSet;

/// Group components into batches for WeiDU invocation.
///
/// Rules:
/// - Components from the same tp2 + language are batched together
/// - Non-consecutive same-mod components are consolidated (preserving mod-level order)
/// - Max batch size is `max_batch_size` (default 25, Windows segfault prevention)
/// - Heavy mods (mih_eq, trap_overhaul) use smaller batches (3)
/// - Duplicate components are skipped
pub fn group_into_batches(components: &[Component], max_batch_size: usize) -> Vec<Batch> {
    // Step 1: Deduplicate and consolidate — group all components by mod, preserving
    // first-appearance order of each mod. This turns non-consecutive same-mod runs
    // (e.g., foo 0,1 → bar 0 → foo 3) into contiguous groups (foo 0,1,3 → bar 0),
    // saving a WeiDU startup per consolidation.
    let consolidated = consolidate_by_mod(components);

    // Step 2: Batch the consolidated list with size limits
    let mut batches: Vec<Batch> = Vec::new();

    for comp in &consolidated {
        let mod_lower = comp.mod_name.to_lowercase();
        let effective_max = if FORCE_SMALL_BATCH_MODS.contains(&mod_lower.as_str()) {
            FORCE_SMALL_BATCH_SIZE
        } else {
            max_batch_size.min(DEFAULT_MAX_BATCH_SIZE)
        };

        let can_extend = batches.last().map_or(false, |b: &Batch| {
            b.tp_file.eq_ignore_ascii_case(&comp.tp_file)
                && b.lang == comp.lang
                && b.components.len() < effective_max
        });

        if can_extend {
            batches.last_mut().unwrap().components.push(comp.clone());
        } else {
            batches.push(Batch {
                mod_name: comp.mod_name.clone(),
                tp_file: comp.tp_file.clone(),
                lang: comp.lang,
                components: vec![comp.clone()],
                batch_index: batches.len(),
            });
        }
    }

    for (i, batch) in batches.iter_mut().enumerate() {
        batch.batch_index = i;
    }

    batches
}

/// Consolidate components so all same-mod components are contiguous.
///
/// Preserves the first-appearance order of each mod in the install list.
/// Within each mod, components keep their original relative order.
/// Deduplicates (same tp_file + component number).
fn consolidate_by_mod(components: &[Component]) -> Vec<Component> {
    use indexmap::IndexMap;

    let mut seen: HashSet<(String, u32)> = HashSet::new();
    // IndexMap preserves insertion order — first-appearance order of each mod
    let mut groups: IndexMap<String, Vec<Component>> = IndexMap::new();

    for comp in components {
        let key = (comp.tp_file.to_lowercase(), comp.component);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let mod_key = comp.tp_file.to_lowercase();
        groups.entry(mod_key).or_default().push(comp.clone());
    }

    groups.into_values().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_comp(mod_name: &str, tp_file: &str, component: u32) -> Component {
        Component {
            tp_file: tp_file.to_string(),
            mod_name: mod_name.to_string(),
            lang: 0,
            component,
            component_name: format!("Component {component}"),
        }
    }

    #[test]
    fn test_consecutive_batching() {
        let comps = vec![
            make_comp("foo", "FOO.TP2", 0),
            make_comp("foo", "FOO.TP2", 1),
            make_comp("foo", "FOO.TP2", 2),
            make_comp("bar", "BAR.TP2", 0),
            make_comp("foo", "FOO.TP2", 3), // Consolidated with earlier foo batch
        ];
        let batches = group_into_batches(&comps, 25);
        // After consolidation: foo 0,1,2,3 → bar 0 (2 batches, not 3)
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].components.len(), 4); // foo 0,1,2,3
        assert_eq!(batches[0].mod_name, "foo");
        assert_eq!(batches[1].components.len(), 1); // bar 0
        assert_eq!(batches[1].mod_name, "bar");
    }

    #[test]
    fn test_consolidation_preserves_mod_order() {
        // First appearance order: foo, bar, baz
        let comps = vec![
            make_comp("foo", "FOO.TP2", 0),
            make_comp("bar", "BAR.TP2", 0),
            make_comp("baz", "BAZ.TP2", 0),
            make_comp("foo", "FOO.TP2", 1),  // Goes back to foo's batch
            make_comp("bar", "BAR.TP2", 1),  // Goes back to bar's batch
        ];
        let batches = group_into_batches(&comps, 25);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].mod_name, "foo");
        assert_eq!(batches[0].components.len(), 2); // foo 0,1
        assert_eq!(batches[1].mod_name, "bar");
        assert_eq!(batches[1].components.len(), 2); // bar 0,1
        assert_eq!(batches[2].mod_name, "baz");
        assert_eq!(batches[2].components.len(), 1); // baz 0
    }

    #[test]
    fn test_max_batch_size() {
        let comps: Vec<_> = (0..30).map(|i| make_comp("big", "BIG.TP2", i)).collect();
        let batches = group_into_batches(&comps, 25);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].components.len(), 25);
        assert_eq!(batches[1].components.len(), 5);
    }

    #[test]
    fn test_deduplication() {
        let comps = vec![
            make_comp("foo", "FOO.TP2", 0),
            make_comp("foo", "FOO.TP2", 0), // Duplicate
            make_comp("foo", "FOO.TP2", 1),
        ];
        let batches = group_into_batches(&comps, 25);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].components.len(), 2); // 0 and 1, not 0,0,1
    }
}
