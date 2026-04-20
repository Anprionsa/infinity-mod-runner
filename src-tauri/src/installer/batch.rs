//! Component batching — groups consecutive components from the same mod into batches.

use super::{Batch, Component, DEFAULT_MAX_BATCH_SIZE};
use std::collections::{HashMap, HashSet};

/// Group components into batches for WeiDU invocation.
///
/// Rules:
/// - Components install in the ORDER THEY APPEAR in the export (`components` input order).
///   This preserves user-intended install ordering — e.g. a mod with a spells-section
///   component placed separately from content-section components stays separated.
/// - Consecutive components from the same tp2 + language are batched together
/// - Non-consecutive same-mod components stay separate (will run WeiDU twice)
/// - Max batch size is `max_batch_size` (default 25, Windows segfault prevention)
/// - Heavy mods (mih_eq, trap_overhaul, dw_talents, stratagems) use smaller batches —
///   size determined by `small_batch_size` (default 3). Set from config.
/// - Duplicate components (same tp_file + component) are skipped
///
/// Historical note: an earlier version of this function consolidated non-consecutive
/// same-mod components into one batch ("save a WeiDU startup"). This broke user
/// ordering — e.g. DSotSC cn:1 (Wizard Spells) placed deliberately at line 983 of the
/// export (in the spell-section) got pulled up to run with cn:0/3/4 at line 218. Users
/// who split a mod across sections did so intentionally; respecting their ordering is
/// correct even at the cost of extra WeiDU invocations.
pub fn group_into_batches(
    components: &[Component],
    max_batch_size: usize,
    small_batch_mods: &[String],
    small_batch_size: usize,
    force_single_cn_mods: &HashMap<String, Vec<u32>>,
) -> Vec<Batch> {
    let deduped = dedupe_preserve_order(components);

    // Build a lookup set for the small-batch mods (case-insensitive).
    let small_set: HashSet<String> = small_batch_mods.iter()
        .map(|s| s.to_lowercase())
        .collect();

    // Normalize the single-cn map for case-insensitive lookup.
    let single_cn_map: HashMap<String, HashSet<u32>> = force_single_cn_mods.iter()
        .map(|(k, v)| (k.to_lowercase(), v.iter().copied().collect()))
        .collect();

    let mut batches: Vec<Batch> = Vec::new();

    for comp in &deduped {
        let mod_lower = comp.mod_name.to_lowercase();
        let effective_max = if small_set.contains(&mod_lower) {
            small_batch_size
        } else {
            max_batch_size.min(DEFAULT_MAX_BATCH_SIZE)
        };

        // A component listed in `force_single_cn_mods` gets its own batch,
        // even within a same-mod sequence. This shards the slowest cn's
        // (e.g. dw_talents HLAs at 60200) so a timeout on one doesn't
        // take its batch-mates down with it.
        let must_be_alone = single_cn_map.get(&mod_lower)
            .map(|set| set.contains(&comp.component))
            .unwrap_or(false);

        // Also prevent the PREVIOUS batch's last component from being
        // extended if it was a force-single cn — that batch is sealed.
        let prev_is_sealed = batches.last().map_or(false, |b| {
            b.components.last().map_or(false, |c| {
                single_cn_map.get(&c.mod_name.to_lowercase())
                    .map(|set| set.contains(&c.component))
                    .unwrap_or(false)
            })
        });

        let can_extend = !must_be_alone && !prev_is_sealed && batches.last().map_or(false, |b: &Batch| {
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

/// Deduplicate components (same tp_file + component number) while preserving input order.
/// Keeps the FIRST occurrence; subsequent duplicates are dropped.
fn dedupe_preserve_order(components: &[Component]) -> Vec<Component> {
    let mut seen: HashSet<(String, u32)> = HashSet::new();
    let mut out = Vec::with_capacity(components.len());
    for comp in components {
        let key = (comp.tp_file.to_lowercase(), comp.component);
        if seen.insert(key) {
            out.push(comp.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{FORCE_SMALL_BATCH_MODS, FORCE_SMALL_BATCH_SIZE};

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
        // Same mod consecutively: batched together
        let comps = vec![
            make_comp("foo", "FOO.TP2", 0),
            make_comp("foo", "FOO.TP2", 1),
            make_comp("foo", "FOO.TP2", 2),
            make_comp("bar", "BAR.TP2", 0),
        ];
        let small_mods: Vec<String> = FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect();
        let empty = HashMap::new();
        let batches = group_into_batches(&comps, 25, &small_mods, FORCE_SMALL_BATCH_SIZE, &empty);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].components.len(), 3); // foo 0,1,2
        assert_eq!(batches[0].mod_name, "foo");
        assert_eq!(batches[1].components.len(), 1); // bar 0
        assert_eq!(batches[1].mod_name, "bar");
    }

    #[test]
    fn test_non_consecutive_same_mod_stays_split() {
        // Regression: DSotSC cn:1 (Wizard Spells) deliberately placed in spell-section
        // MUST NOT be consolidated with DSotSC cn:0/3/4 at the content-section position.
        let comps = vec![
            make_comp("dsotsc", "DSOTSC.TP2", 0),   // content section
            make_comp("dsotsc", "DSOTSC.TP2", 3),
            make_comp("dsotsc", "DSOTSC.TP2", 4),
            make_comp("other_a", "OA.TP2", 0),        // other content
            make_comp("other_b", "OB.TP2", 0),
            make_comp("dsotsc", "DSOTSC.TP2", 1),   // intentionally placed in spell section
            make_comp("other_c", "OC.TP2", 0),
        ];
        let small_mods: Vec<String> = FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect();
        let empty = HashMap::new();
        let batches = group_into_batches(&comps, 25, &small_mods, FORCE_SMALL_BATCH_SIZE, &empty);
        assert_eq!(batches.len(), 5, "expected 5 batches — dsotsc should be split");
        assert_eq!(batches[0].mod_name, "dsotsc");
        assert_eq!(batches[0].components.len(), 3); // 0,3,4
        assert_eq!(batches[1].mod_name, "other_a");
        assert_eq!(batches[2].mod_name, "other_b");
        assert_eq!(batches[3].mod_name, "dsotsc");
        assert_eq!(batches[3].components.len(), 1); // 1 (spell-section)
        assert_eq!(batches[4].mod_name, "other_c");
    }

    #[test]
    fn test_max_batch_size() {
        let comps: Vec<_> = (0..30).map(|i| make_comp("big", "BIG.TP2", i)).collect();
        let small_mods: Vec<String> = FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect();
        let empty = HashMap::new();
        let batches = group_into_batches(&comps, 25, &small_mods, FORCE_SMALL_BATCH_SIZE, &empty);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].components.len(), 25);
        assert_eq!(batches[1].components.len(), 5);
    }

    #[test]
    fn test_force_single_cn_shards_into_its_own_batch() {
        // dw_talents cn:60200 and cn:60300 are known-slow; a 2h timeout on
        // one shouldn't drag its batch-mates into an AUTO_SKIP. Verify the
        // batcher isolates them.
        let comps = vec![
            make_comp("dw_talents", "DWT.TP2", 60100), // fine — packs with next
            make_comp("dw_talents", "DWT.TP2", 60200), // must be alone
            make_comp("dw_talents", "DWT.TP2", 60300), // must be alone
            make_comp("dw_talents", "DWT.TP2", 80000), // fine — new batch after sealed 60300
            make_comp("dw_talents", "DWT.TP2", 80010), // packs with 80000
        ];
        let small_mods: Vec<String> = FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect();
        let mut single_cn = HashMap::new();
        single_cn.insert("dw_talents".to_string(), vec![60200u32, 60300]);
        let batches = group_into_batches(&comps, 25, &small_mods, FORCE_SMALL_BATCH_SIZE, &single_cn);

        // Expected 4 batches:
        //   [60100]  (sealed-next-because-60200-is-force-single)
        //   [60200]  (force-single)
        //   [60300]  (force-single)
        //   [80000, 80010]
        assert_eq!(batches.len(), 4);
        assert_eq!(batches[0].components.iter().map(|c| c.component).collect::<Vec<_>>(), vec![60100]);
        assert_eq!(batches[1].components.iter().map(|c| c.component).collect::<Vec<_>>(), vec![60200]);
        assert_eq!(batches[2].components.iter().map(|c| c.component).collect::<Vec<_>>(), vec![60300]);
        assert_eq!(batches[3].components.iter().map(|c| c.component).collect::<Vec<_>>(), vec![80000, 80010]);
    }

    #[test]
    fn test_deduplication() {
        let comps = vec![
            make_comp("foo", "FOO.TP2", 0),
            make_comp("foo", "FOO.TP2", 0), // Duplicate
            make_comp("foo", "FOO.TP2", 1),
        ];
        let small_mods: Vec<String> = FORCE_SMALL_BATCH_MODS.iter().map(|s| s.to_string()).collect();
        let empty = HashMap::new();
        let batches = group_into_batches(&comps, 25, &small_mods, FORCE_SMALL_BATCH_SIZE, &empty);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].components.len(), 2); // 0 and 1, not 0,0,1
    }
}
