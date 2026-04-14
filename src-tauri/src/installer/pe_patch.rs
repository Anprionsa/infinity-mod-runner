//! PE header patcher — increases WeiDU's stack size to prevent stack overflow segfaults.
//!
//! WeiDU is compiled with OCaml's native compiler (ocamlopt) which uses the default
//! Windows PE stack reserve of 1MB. Deep recursion in COPY_EXISTING_REGEXP or TP2
//! parsing can overflow this. We patch the PE optional header to set 32MB stack reserve.

use std::path::Path;

const TARGET_STACK_RESERVE: u64 = 32 * 1024 * 1024; // 32 MB

/// Check if the WeiDU binary has a small stack and patch it if needed.
/// Returns Ok(true) if patched, Ok(false) if already adequate, Err on failure.
#[cfg(target_os = "windows")]
pub fn ensure_adequate_stack(weidu_path: &Path) -> Result<bool, String> {
    let data = std::fs::read(weidu_path)
        .map_err(|e| format!("Failed to read WeiDU binary: {e}"))?;

    if data.len() < 512 {
        return Err("File too small to be a valid PE".to_string());
    }

    // Check MZ signature
    if data[0] != b'M' || data[1] != b'Z' {
        return Err("Not a valid PE file (no MZ signature)".to_string());
    }

    // Get PE header offset from e_lfanew (offset 0x3C, 4 bytes LE)
    let pe_offset = u32::from_le_bytes([data[0x3C], data[0x3D], data[0x3E], data[0x3F]]) as usize;
    if pe_offset + 4 > data.len() {
        return Err("Invalid PE offset".to_string());
    }

    // Check PE signature
    if &data[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err("Invalid PE signature".to_string());
    }

    // COFF header starts at pe_offset + 4
    let coff_offset = pe_offset + 4;
    // SizeOfOptionalHeader at offset 16 from COFF start
    let opt_header_size = u16::from_le_bytes([
        data[coff_offset + 16], data[coff_offset + 17],
    ]) as usize;

    if opt_header_size < 96 {
        return Err("Optional header too small".to_string());
    }

    // Optional header starts after COFF header (20 bytes)
    let opt_offset = coff_offset + 20;

    // Check PE32 vs PE32+ (magic number)
    let magic = u16::from_le_bytes([data[opt_offset], data[opt_offset + 1]]);
    let (stack_reserve_offset, is_64bit) = match magic {
        0x10B => (opt_offset + 72, false),  // PE32: SizeOfStackReserve at offset 72
        0x20B => (opt_offset + 72, true),   // PE32+: SizeOfStackReserve at offset 72 (but 8 bytes)
        _ => return Err(format!("Unknown PE magic: 0x{magic:04X}")),
    };

    if stack_reserve_offset + if is_64bit { 8 } else { 4 } > data.len() {
        return Err("Stack reserve offset beyond file".to_string());
    }

    // Read current stack reserve
    let current_stack = if is_64bit {
        u64::from_le_bytes([
            data[stack_reserve_offset], data[stack_reserve_offset + 1],
            data[stack_reserve_offset + 2], data[stack_reserve_offset + 3],
            data[stack_reserve_offset + 4], data[stack_reserve_offset + 5],
            data[stack_reserve_offset + 6], data[stack_reserve_offset + 7],
        ])
    } else {
        u32::from_le_bytes([
            data[stack_reserve_offset], data[stack_reserve_offset + 1],
            data[stack_reserve_offset + 2], data[stack_reserve_offset + 3],
        ]) as u64
    };

    if current_stack >= TARGET_STACK_RESERVE {
        return Ok(false); // Already adequate
    }

    // Patch the stack reserve.
    // Note: PE CheckSum (optional header offset 64) is NOT updated. This is safe because
    // Windows only validates checksums for kernel drivers and certain system DLLs, not
    // user-mode executables like weidu.exe.
    let mut patched = data;
    let new_bytes = if is_64bit {
        TARGET_STACK_RESERVE.to_le_bytes().to_vec()
    } else {
        (TARGET_STACK_RESERVE as u32).to_le_bytes().to_vec()
    };

    for (i, byte) in new_bytes.iter().enumerate() {
        patched[stack_reserve_offset + i] = *byte;
    }

    std::fs::write(weidu_path, &patched)
        .map_err(|e| format!("Failed to write patched WeiDU: {e}"))?;

    Ok(true)
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_adequate_stack(_weidu_path: &Path) -> Result<bool, String> {
    Ok(false) // No PE patching needed on non-Windows
}
