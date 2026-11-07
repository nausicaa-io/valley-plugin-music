//! Music's artist-credits kernel. JavaScript writes every track's credit fields into the buffer `credits_input`
//! returns (UTF-8 records `artist \x01 feat \x01 artists[0] \x02 artists[1] … \x00`) and each track's explicit
//! artist count into `credits_counts`, then calls `credits_run(bytes, tracks)`. A record whose separators disagree
//! with its count (a control character inside a name) fails the run, and the caller falls back to TypeScript.
//! Results: `credits_output` holds `[displays, keys, display_key…, then per track: count, display ids…]` as `u32`s,
//! `credits_strings` the display names and then the keys, joined by `\0`. The Valley ABI exports are present
//! because the host requires them of every module; `valley_call` answers no method.

#[forbid(unsafe_code)]
mod credits;

use std::cell::RefCell;

use credits::{Credits, Fields};
use valley_plugin_abi::{ABI_VERSION, Status, encode_response, pack_region};

#[derive(Default)]
struct State {
    input: Vec<u8>,
    counts: Vec<u32>,
    output: Vec<u32>,
    strings: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn address<T>(values: &[T]) -> u32 {
    u32::try_from(values.as_ptr() as usize).unwrap_or(0)
}

fn len32(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// The input buffer, at least `bytes` long (zero-filled; its address changes when it grows).
#[unsafe(no_mangle)]
pub extern "C" fn credits_input(bytes: u32) -> u32 {
    STATE.with(|state| {
        let input = &mut state.borrow_mut().input;
        input.resize(bytes as usize, 0);
        address(input)
    })
}

/// The per-track explicit artist counts, `tracks` entries.
#[unsafe(no_mangle)]
pub extern "C" fn credits_counts(tracks: u32) -> u32 {
    STATE.with(|state| {
        let counts = &mut state.borrow_mut().counts;
        counts.resize(tracks as usize, 0);
        address(counts)
    })
}

fn parse<'a>(input: &'a str, counts: &[u32]) -> Option<Vec<Fields<'a>>> {
    if counts.is_empty() {
        return input.is_empty().then(Vec::new);
    }
    let body = input.strip_suffix('\0')?;
    let mut tracks = Vec::with_capacity(counts.len());
    let mut records = body.split('\0');
    for &count in counts {
        let mut parts = records.next()?.split('\u{1}');
        let (artist, feat, explicit) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let explicit: Vec<&str> = if count == 0 {
            if !explicit.is_empty() {
                return None;
            }
            Vec::new()
        } else {
            explicit.split('\u{2}').collect()
        };
        if explicit.len() != count as usize {
            return None;
        }
        tracks.push(Fields { artist, feat, explicit });
    }
    records.next().is_none().then_some(tracks)
}

/// Credits for `tracks` records in the first `bytes` input bytes; 1 when the results are ready, 0 when the input is malformed.
#[unsafe(no_mangle)]
pub extern "C" fn credits_run(bytes: u32, tracks: u32) -> u32 {
    STATE.with(|state| {
        let state = &mut *state.borrow_mut();
        state.output.clear();
        state.strings.clear();
        let (Some(input), Some(counts)) = (state.input.get(..bytes as usize), state.counts.get(..tracks as usize)) else {
            return 0;
        };
        let Ok(input) = std::str::from_utf8(input) else { return 0 };
        let Some(fields) = parse(input, counts) else { return 0 };
        let mut credits = Credits::default();
        for track in &fields {
            credits.add(track);
        }
        credits.finish();
        let output = &mut state.output;
        output.reserve(2 + credits.display_key.len() + credits.tracks.iter().map(|ids| 1 + ids.len()).sum::<usize>());
        output.push(len32(credits.displays.len()));
        output.push(len32(credits.keys.len()));
        output.extend_from_slice(&credits.display_key);
        for ids in &credits.tracks {
            output.push(len32(ids.len()));
            output.extend_from_slice(ids);
        }
        let strings = &mut state.strings;
        for (index, text) in credits
            .displays
            .iter()
            .copied()
            .chain(credits.keys.iter().map(String::as_str))
            .enumerate()
        {
            if index > 0 {
                strings.push(0);
            }
            strings.extend_from_slice(text.as_bytes());
        }
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn credits_output() -> u32 {
    STATE.with(|state| address(&state.borrow().output))
}

#[unsafe(no_mangle)]
pub extern "C" fn credits_output_len() -> u32 {
    STATE.with(|state| len32(state.borrow().output.len()))
}

#[unsafe(no_mangle)]
pub extern "C" fn credits_strings() -> u32 {
    STATE.with(|state| address(&state.borrow().strings))
}

#[unsafe(no_mangle)]
pub extern "C" fn credits_strings_len() -> u32 {
    STATE.with(|state| len32(state.borrow().strings.len()))
}

/// Releases the buffers between runs so a large library does not pin its peak memory.
#[unsafe(no_mangle)]
pub extern "C" fn credits_reset() {
    STATE.with(|state| *state.borrow_mut() = State::default());
}

fn leak(bytes: Vec<u8>) -> u64 {
    let boxed = bytes.into_boxed_slice();
    let len = u32::try_from(boxed.len()).unwrap_or(0);
    let ptr = Box::into_raw(boxed).cast::<u8>() as usize;
    pack_region(u32::try_from(ptr).unwrap_or(0), len)
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_alloc(len: u32) -> u32 {
    let ptr = Box::into_raw(vec![0_u8; len as usize].into_boxed_slice()).cast::<u8>() as usize;
    u32::try_from(ptr).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_free(ptr: u32, len: u32) {
    if ptr == 0 {
        return;
    }
    // SAFETY: `ptr`/`len` describe a boxed slice this module leaked from `valley_alloc` or a response frame; the host
    // frees each region exactly once.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as usize as *mut u8, len as usize)) });
}

/// The frame-dispatched entry: the kernel is driven through its direct exports, so every method is unknown.
#[unsafe(no_mangle)]
pub extern "C" fn valley_call(_ptr: u32, _len: u32) -> u64 {
    leak(encode_response(
        Status::Error,
        b"music credits has no framed methods; call the credits_* exports",
    ))
}
