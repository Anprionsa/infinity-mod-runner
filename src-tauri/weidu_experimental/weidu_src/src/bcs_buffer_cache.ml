(* LRU buffer cache for BCS/BAF resources loaded via Load.load_resource.

   Rationale: COPY_EXISTING_REGEXP re-loads the same biffed BCSes
   repeatedly during SFO-library mod installs. Every call re-runs zlib
   decompression via Biff.read_compressed_biff. A 1600-component EET
   stack touches the same BCS files hundreds of times. Caching buffers
   here avoids the redundant I/O + decompression.

   Design:
   - Keyed by (name_upper, ext_upper). No epoch — full clear() on KEY
     reload is simpler and equivalent.
   - Scope-gated to BCS+BAF only. Other resource types fall through.
   - LRU with hard byte-budget cap (default 256 MB). Configurable via
     WEIDU_BCS_CACHE_MB env var at startup. Setting it to 0 disables
     the cache entirely (every lookup returns miss, no insertions) —
     used for A/B measurement. Negative values fall back to default.
   - Buffers are defensively copied on both insert and lookup because
     the build runs with default-unsafe-string (strings are mutable) and
     callers of load_resource are known to mutate (see tpaction.ml:791).
   - Single-threaded safe (WeiDU has no threads). Plain Hashtbl.
   - Invalidated on writes (per-file) and KEY reloads (full clear).

   Integration points:
   - Load.load_resource — consult cache at entry, populate on miss.
   - Util.open_for_writing_internal — per-file invalidation on write.
     Catches: COPY/COPY_EXISTING/COPY_LARGE, EXTEND_TOP/BOTTOM,
     COMPILE_BAF_TO_BCS, and any other write that uses the standard
     helper.
   - Tpaction TP_Delete / TP_Move — direct invalidation for sys_remove
     and unix_rename paths that bypass open_for_writing.
   - Tpaction TP_Biff / TP_DecompressBiff — full clear on KEY reload. *)

open BatteriesInit
open Hashtblinit

(* ────────── Configuration ────────── *)

let default_max_mb = 256
let env_var = "WEIDU_BCS_CACHE_MB"

(* Parse the env var. Three states:
   - unset or malformed  → default (256 MB)
   - exactly 0           → disabled (0 bytes = every lookup misses)
   - negative            → treat as unset, use default
   - positive            → that many MB *)
let read_max_bytes () =
  let mb =
    try
      let s = Sys.getenv env_var in
      let n = int_of_string (String.trim s) in
      if n < 0 then default_max_mb else n
    with _ -> default_max_mb
  in
  mb * 1024 * 1024

let max_bytes = ref (read_max_bytes ())

(* Cache is disabled when budget is 0. Used to short-circuit both
   lookup and insert so A/B measurement is clean. *)
let enabled () = !max_bytes > 0

(* Reject single entries larger than this fraction of the cap — otherwise
   one huge BCS could evict everything else. *)
let single_entry_limit () = !max_bytes / 4

(* ────────── Scope gate ────────── *)

let is_cacheable_ext ext =
  let u = String.uppercase ext in
  u = "BCS" || u = "BAF"

(* ────────── State ────────── *)

type entry = {
  buffer : string ;
  path : string ;
  size : int ;
}

(* (name_upper, ext_upper) -> entry *)
let table : (string * string, entry) Hashtbl.t = Hashtbl.create 4096

(* (name_upper, ext_upper) -> access counter. Higher = more recent. *)
let access_time : (string * string, int) Hashtbl.t = Hashtbl.create 4096

let counter = ref 0
let current_bytes = ref 0

(* Stats counters, cleared alongside the cache. *)
let hits = ref 0
let misses = ref 0
let evictions = ref 0
let peak_bytes = ref 0

(* ────────── Internal helpers ────────── *)

let key_of name ext =
  (String.uppercase name, String.uppercase ext)

let touch key =
  incr counter ;
  Hashtbl.replace access_time key !counter

let remove_entry key =
  (try
    let e = Hashtbl.find table key in
    current_bytes := !current_bytes - e.size
  with Not_found -> ()) ;
  Hashtbl.remove table key ;
  Hashtbl.remove access_time key

(* Find the key with the lowest access time. O(N) over entries; N stays
   small because total bytes are capped. *)
let find_lru_key () =
  let lru_key = ref None in
  let lru_time = ref max_int in
  Hashtbl.iter (fun k t ->
    if t < !lru_time then begin
      lru_time := t ;
      lru_key := Some k
    end) access_time ;
  !lru_key

let rec make_room needed =
  if !current_bytes + needed > !max_bytes && Hashtbl.length table > 0 then begin
    (match find_lru_key () with
     | Some k ->
       remove_entry k ;
       incr evictions
     | None -> ()) ;
    make_room needed
  end

(* ────────── Public API ────────── *)

(* This build runs with default-unsafe-string, so `string` is mutable.
   Callers of load_resource assume each call returns a FRESH buffer and
   sometimes mutate it in place (e.g. tpaction.ml:791 copies defensively
   only after patching starts). The cache must not let those mutations
   leak across consumers, so we copy on both insert and lookup. Copy
   cost is O(N) memcpy — microseconds on a typical BCS, still vastly
   cheaper than the re-read + zlib decompress we're saving. *)
let copy_string s = Bytes.to_string (Bytes.of_string s)

(* Look up a BCS/BAF resource. Returns None on miss, or if the cache
   is disabled (WEIDU_BCS_CACHE_MB=0), or if ext is not cacheable. On
   hit, returns a fresh copy so downstream mutation can't contaminate
   other consumers of the same resource. *)
let lookup name ext =
  if not (enabled ()) || not (is_cacheable_ext ext) then None
  else begin
    let key = key_of name ext in
    try
      let e = Hashtbl.find table key in
      touch key ;
      incr hits ;
      Some (copy_string e.buffer, e.path)
    with Not_found ->
      incr misses ;
      None
  end

(* Insert a (name, ext, buffer, path) into the cache. No-op if the
   cache is disabled, ext is not cacheable, or the entry exceeds the
   single-entry size limit. Stores its own copy of the buffer so
   future caller-side mutation can't corrupt the cached entry. *)
let insert name ext buffer path =
  if not (enabled ()) || not (is_cacheable_ext ext) then ()
  else begin
    let size = String.length buffer in
    if size = 0 || size > single_entry_limit () then ()
    else begin
      let key = key_of name ext in
      (* Subtract old size if replacing an existing entry. *)
      (try
        let old = Hashtbl.find table key in
        current_bytes := !current_bytes - old.size
      with Not_found -> ()) ;
      make_room size ;
      Hashtbl.replace table key
        { buffer = copy_string buffer ; path ; size } ;
      current_bytes := !current_bytes + size ;
      if !current_bytes > !peak_bytes then peak_bytes := !current_bytes ;
      touch key
    end
  end

(* Invalidate a single resource by (name, ext). Called on per-file
   writes (save_bcs, copy_one_file write branch). No-op for non-BCS. *)
let invalidate name ext =
  if not (is_cacheable_ext ext) then ()
  else remove_entry (key_of name ext)

(* Invalidate by full path — splits basename to (name, ext) and calls
   invalidate. Use this when the caller has a path but not pre-split
   name/ext (e.g., open_for_writing hook, save_bcs). No-op for non-BCS
   paths, unknown extensions, or malformed paths. *)
let invalidate_path path =
  try
    let base = Filename.basename path in
    let dot = String.rindex base '.' in
    let name = String.sub base 0 dot in
    let ext = String.sub base (dot + 1) (String.length base - dot - 1) in
    invalidate name ext
  with _ -> ()

(* Full clear — called on KEY reloads (MAKE_BIFF, DECOMPRESS_BIFF) and
   any other coarse game-state change. Preserves stats counters so we
   can log cumulative cache effectiveness at exit. *)
let clear () =
  Hashtbl.clear table ;
  Hashtbl.clear access_time ;
  current_bytes := 0 ;
  counter := 0

(* (hits, misses, evictions, current_bytes, peak_bytes) *)
let stats () =
  (!hits, !misses, !evictions, !current_bytes, !peak_bytes)

let reset_stats () =
  hits := 0 ;
  misses := 0 ;
  evictions := 0 ;
  peak_bytes := 0

(* Runtime override, e.g. for tests. Does not re-read the env var. *)
let set_max_bytes n =
  if n > 0 then begin
    max_bytes := n ;
    make_room 0
  end

let get_max_bytes () = !max_bytes

(* ────────── Exit-time reporting ────────── *)

(* Two lines emitted on stderr at program exit:

   1. BCS_CACHE_STATS_JSON <json> — machine-readable, ALWAYS emitted (even
      when disabled or cold). This is the wire format the mod runner's
      Rust side parses. Keeping it always-on lets the UI distinguish
      "cache off" / "cache on but cold" / "cache on and worked" without
      needing to track binary state externally. Fields are stable; add
      new ones with sensible defaults so older parsers don't break.

   2. BCS buffer cache: ... — human-readable summary, only when the cache
      saw traffic. Preserved for developer stderr-tail debugging and
      because some log readers already grep for this prefix.

   Both emissions are unconditional writes via Printf.eprintf, inside
   at_exit so they fire even on normal termination. They do NOT fire on
   unclean exits like segfaults (OCaml runtime never calls at_exit then),
   so a missing emission is a signal that WeiDU died hard. *)
let () =
  at_exit (fun () ->
    let h, m, e, cur, peak = stats () in
    let total = h + m in
    let rate =
      if total = 0 then 0.0
      else 100.0 *. float_of_int h /. float_of_int total
    in
    (* Machine-readable: always on. Fields are plain numbers/bool, so no
       JSON escaping is needed. Order is stable; keep it this way. *)
    Printf.eprintf
      "BCS_CACHE_STATS_JSON {\"enabled\":%b,\"hits\":%d,\"misses\":%d,\"hit_rate_pct\":%.1f,\"evictions\":%d,\"peak_kb\":%d,\"current_kb\":%d,\"max_mb\":%d}\n"
      (enabled ())
      h m rate e
      (peak / 1024)
      (cur / 1024)
      (!max_bytes / (1024 * 1024)) ;
    (* Human-readable: gate on traffic to reduce noise on cold runs. *)
    if total > 0 then
      Printf.eprintf
        "BCS buffer cache: %d hits / %d misses (%.1f%% hit rate), %d evictions, peak %d KB\n"
        h m rate e (peak / 1024))
