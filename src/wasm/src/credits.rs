//! Artist credits, bit-for-bit the TypeScript `trackArtists` (src/artists.ts): `ARTIST_SPLIT_RE` as
//! `String.prototype.split` applies it, `String.prototype.trim`, `normalizeArtistName` and the first-seen
//! de-duplication. JavaScript's `\s` and `trim` use the same whitespace set, spelled out in `is_js_space`; the
//! collab words match ASCII case-insensitively (a non-unicode `i` regex never folds a non-ASCII character to ASCII).

use std::collections::HashMap;

pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn skip_space(s: &str, mut i: usize) -> usize {
    while let Some(c) = s[i..].chars().next() {
        if !is_js_space(c) {
            break;
        }
        i += c.len_utf8();
    }
    i
}

/// `\s+` at `i`: the end of the run, or `None` when no whitespace starts there.
fn space_run(s: &str, i: usize) -> Option<usize> {
    let end = skip_space(s, i);
    (end > i).then_some(end)
}

fn word_at(s: &str, i: usize, word: &str) -> Option<usize> {
    let end = i + word.len();
    (s.len() >= end && s.as_bytes()[i..end].eq_ignore_ascii_case(word.as_bytes())).then_some(end)
}

/// `\s*[,;&×]\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?|x)\s+` matched at `q`; returns the end of the match.
fn split_match(s: &str, q: usize) -> Option<usize> {
    let i = skip_space(s, q);
    if let Some(c) = s[i..].chars().next()
        && matches!(c, ',' | ';' | '&' | '×')
    {
        return Some(skip_space(s, i + c.len_utf8()));
    }
    let i = space_run(s, q)?;
    for (word, dot) in [("feat", true), ("ft", true), ("featuring", false), ("vs", true), ("x", false)] {
        let Some(end) = word_at(s, i, word) else { continue };
        if dot
            && s.as_bytes().get(end) == Some(&b'.')
            && let Some(e) = space_run(s, end + 1)
        {
            return Some(e);
        }
        if let Some(e) = space_run(s, end) {
            return Some(e);
        }
    }
    None
}

/// `s.split(ARTIST_SPLIT_RE)`: the pattern never matches empty, so every match advances.
pub fn split_artists<'a>(s: &'a str, out: &mut Vec<&'a str>) {
    let (mut p, mut q) = (0, 0);
    while q < s.len() {
        match split_match(s, q) {
            Some(e) => {
                out.push(&s[p..q]);
                p = e;
                q = e;
            }
            None => q += s[q..].chars().next().map_or(1, char::len_utf8),
        }
    }
    out.push(&s[p..]);
}

/// `name.trim().replace(/\s+/g, ' ').toLowerCase()`.
pub fn normalize(name: &str) -> String {
    let mut collapsed = String::with_capacity(name.len());
    let mut space = false;
    for c in js_trim(name).chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space {
                collapsed.push(' ');
                space = false;
            }
            collapsed.push(c);
        }
    }
    collapsed.to_lowercase()
}

/// One track's credit fields: the `artist` string (unused when `explicit` is non-empty), `details.feat` and `artists[]`.
pub struct Fields<'a> {
    pub artist: &'a str,
    pub feat: &'a str,
    pub explicit: Vec<&'a str>,
}

/// The interned result: per track the display-name ids, per display name its normalized key id.
#[derive(Default)]
pub struct Credits<'a> {
    pub displays: Vec<&'a str>,
    pub display_key: Vec<u32>,
    pub keys: Vec<String>,
    pub tracks: Vec<Vec<u32>>,
    display_ids: HashMap<&'a str, u32>,
    key_ids: HashMap<String, u32>,
}

impl<'a> Credits<'a> {
    fn display(&mut self, name: &'a str) -> (u32, u32) {
        if let Some(&id) = self.display_ids.get(name) {
            return (id, self.display_key[id as usize]);
        }
        let key = normalize(name);
        let next = u32::try_from(self.key_ids.len()).unwrap_or(u32::MAX);
        let key_id = *self.key_ids.entry(key).or_insert(next);
        if key_id == next {
            self.keys.push(String::new());
        }
        let id = u32::try_from(self.displays.len()).unwrap_or(u32::MAX);
        self.display_ids.insert(name, id);
        self.displays.push(name);
        self.display_key.push(key_id);
        (id, key_id)
    }

    /// `trackArtists(track)`: featured names split from `feat`, explicit names unsplit, else the split `artist.trim()`.
    pub fn add(&mut self, fields: &Fields<'a>) {
        let mut raw = Vec::new();
        if fields.explicit.is_empty() {
            split_artists(js_trim(fields.artist), &mut raw);
        } else {
            raw.extend_from_slice(&fields.explicit);
        }
        split_artists(fields.feat, &mut raw);
        let mut seen: Vec<u32> = Vec::with_capacity(raw.len());
        let mut ids = Vec::with_capacity(raw.len());
        for part in raw {
            let name = js_trim(part);
            if name.is_empty() {
                continue;
            }
            let (id, key) = self.display(name);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            ids.push(id);
        }
        self.tracks.push(ids);
    }

    /// Fills `keys` (indexed by key id) once every track is added.
    pub fn finish(&mut self) {
        for (key, &id) in &self.key_ids {
            self.keys[id as usize].clone_from(key);
        }
    }
}
