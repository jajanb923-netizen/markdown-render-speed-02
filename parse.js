// parse.js — a fast, dependency-free Markdown-to-HTML renderer.
//
// Returns exactly the HTML that marked 18.1.3 produces with its default
// options (GFM on, breaks off, pedantic off, async off). Written from the
// CommonMark 0.31.2 / GFM 0.29 specs plus marked's observable behaviour:
// where marked departs from the specs, marked wins.
//
// Architecture: a line-based block lexer produces block nodes (link reference
// definitions are collected for the whole document first), then a renderer
// walks the blocks and inline-parses each text span with an opener-driven
// emphasis/delimiter scanner that mirrors marked's.
//
// parse() is stateless across calls: every call builds fresh state. Only
// read-only module-level tables and regexes are shared.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

// Tags whose inline form suppresses numeric-entity decoding in text.
const RAW_INLINE = new Set(['pre', 'code', 'kbd', 'script']);

// ASCII punctuation that a backslash can escape.
const ESCAPABLE = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'].map((c) => c.charCodeAt(0)));

// ---- char-class lookup tables (ASCII) ----
// KIND flags per ASCII code: 1 = space-ish, 2 = punctuation, 4 = alnum.
const KIND = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') KIND[i] |= 1;
  if ((i >= 48 && i <= 57) || (i >= 65 && i <= 90) || (i >= 97 && i <= 122)) KIND[i] |= 4;
}
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') KIND[c.charCodeAt(0)] |= 2;

// STOP flags: chars that end a plain-text run in the inline scanner.
// bit 1 = hard stop (tokenizer boundary), bit 2 = maybe-URL start, bit 4 = '@'.
const STOP = new Uint8Array(128);
for (const c of '\\<[*_`~\n&!') STOP[c.charCodeAt(0)] |= 1;
for (const c of 'whfmx') STOP[c.charCodeAt(0)] |= 2;
STOP['@'.charCodeAt(0)] |= 4;
// Local-part chars for bare e-mail addresses.
const LOCAL = new Uint8Array(128);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-") LOCAL[c.charCodeAt(0)] = 1;
// Domain chars for bare e-mail / URL hosts.
const DOM = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.') DOM[c.charCodeAt(0)] = 1;

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isSpaceCode(code) {
  return code < 128 ? (KIND[code] & 1) !== 0 : code === 0x85 || code === 0xa0 || /\s/.test(String.fromCharCode(code));
}
function isPunctCh(code) {
  if (code < 128) return (KIND[code] & 2) !== 0;
  return PUNCT_RE.test(String.fromCodePoint(code));
}
function isAlnumCh(code) {
  if (code < 128) return (KIND[code] & 4) !== 0;
  return ALNUM_RE.test(String.fromCodePoint(code));
}
// Unicode-aware "is this a letter or number" for a single code point string.
function isWordCh(ch) { return isAlnumCh(ch); }

// ---- escaping ----
// No-encode mode: escape < > " ' always; escape & only when it does not
// start something that looks like an entity (&#digits; &#xhex; or word;).
const NOENC_AMP = /&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;
function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else if (c === '&') {
      // Is this & the start of an entity-looking sequence?
      const m = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/.exec(s.slice(i));
      if (m) continue;
      rep = '&amp;';
    }
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Encode mode: escape & < > " ' unconditionally (code spans/blocks, autolink text).
function escAll(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in a text run (never inside code or
// raw inline tags). Invalid / out-of-range code points become U+FFFD.
const NUMREF_RE = /&(#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6}));/g;
function decodeNumeric(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMREF_RE, (whole, body) => {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else cp = parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// Decode a single numeric reference starting at s[i] ('&'). Returns
// {ch, next} or null when s[i] does not start a valid numeric reference.
function decodeNumericAt(s, i) {
  if (s.charCodeAt(i) !== 38 || s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const ds = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
            : (c >= 48 && c <= 57)) { j++; continue; }
    break;
  }
  const len = j - ds;
  if (len === 0 || len > (hex ? 6 : 7) || j >= s.length || s.charCodeAt(j) !== 59) return null;
  const cp = hex ? parseInt(s.slice(ds, j), 16) : parseInt(s.slice(ds, j), 10);
  const ch = (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) ? '\uFFFD' : String.fromCodePoint(cp);
  return { ch, next: j + 1 };
}

// Normalise a link label: trim, collapse whitespace runs to one space,
// then a locale-independent case fold.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Href encoding: encodeURI, then turn %25 back into % (marked's undo step).
function encodeHref(href) {
  return encodeURI(href).replace(/%25/g, '%');
}

// ---- inline helpers ----

// Count how many times `ch` repeats starting at i.
function countRun(s, i, ch) {
  let n = 0;
  if (typeof ch === 'number') {
    while (i + n < s.length && s.charCodeAt(i + n) === ch) n++;
  } else {
    while (i + n < s.length && s[i + n] === ch) n++;
  }
  return n;
}

// Find the end of a code span whose opening backtick run starts at i
// (run length L). Returns the index just past the closing run, or -1.
// The closing run must be the same length and not followed by a backtick.
function codeSpanEnd(s, i, L) {
  let j = i + L;
  while (j < s.length) {
    if (s[j] === '`') {
      const r = countRun(s, j, '`');
      if (r === L && s[j + r] !== '`') return j + r;
      j += r;
    } else {
      j++;
    }
  }
  return -1;
}

// Scan a reference label starting at the `[` at position i (the `[...]`
// after a link text). Returns the index of the `]` closing the label, or
// -1. A reference label holds no unescaped '[' (a label containing one is
// not a label at all, and the shortcut form is tried instead); escapes
// skip two chars and a backtick run must form a complete code span.
function scanRefLabel(s, i) {
  const len = s.length;
  let j = i + 1;
  while (j < len) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') return j;
    if (c === '`') {
      const L = countRun(s, j, '`');
      const e = codeSpanEnd(s, j, L);
      // A backtick run only shields a `]` when it forms a complete code
      // span. An unmatched run is literal text: the `]` after it still
      // closes the link text (e.g. `[add ``fixes`](u)` is a link).
      if (e < 0) { j += L; continue; }
      j = e;
      continue;
    }
    j++;
  }
  return -1;
}

// Match a raw HTML tag (comment, open/close tag, PI, declaration, CDATA)
// at position i. Returns the tag length, or 0 when there is none.
// Attribute values may contain `>` inside quotes.
const TAG_RE = /^(?:<!-->|<!--->|<!--[\s\S]*?-->|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<\?[\s\S]*?\?>|<![a-zA-Z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;
function matchTag(s, i) {
  const m = TAG_RE.exec(s.slice(i, i + 4000));
  return m ? m[0].length : 0;
}

// Parse a tag name out of a matched tag string (lower-cased, without /).
function tagNameOf(tag) {
  let i = tag[1] === '/' ? 2 : 1;
  let j = i;
  while (j < tag.length && /[a-zA-Z0-9-]/.test(tag[j])) j++;
  return tag.slice(i, j).toLowerCase();
}
function tagIsClose(tag) { return tag[1] === '/'; }

// Scan link text starting at the `[` at position i. Returns the index of
// the `]` that closes the text, or -1 when the text is not a valid link
// text. Model (probed against marked 18.1.3): bracket depth — `[` nests,
// `]` closes when depth returns to 0; escapes skip two chars; a backtick
// run shields a `]` only as a code span — the next backtick run (of any
// length) closes it — and a run with no later run is literal only when
// it is two or more backticks immediately before the `]`; otherwise the
// text is not a link text (e.g. `[add ``fixes`](u)` is a link, but
// `[empty test `a ` b` output](u)` is not: its last backtick run has no
// later run and is a single backtick).
function scanLinkText(s, i) {
  const len = s.length;
  let depth = 1;
  let j = i + 1;
  while (j < len) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    if (c === '`') {
      const L = countRun(s, j, '`');
      // A run of 2+ backticks immediately before the closing `]` is
      // literal text (it does not pair with a later backtick run past
      // the `]`); this check comes first, so a later backtick elsewhere
      // in the paragraph cannot swallow the label close.
      if (L >= 2 && j + L < len && s[j + L] === ']') { j += L; continue; }
      // A backtick run shields the text only as a code span: the next
      // backtick run (of any length) closes it, and the scan continues
      // past it. A run with no later run is literal only when it is two
      // or more backticks immediately before the closing `]`; otherwise
      // the text is not a link text at all.
      let k = j + L;
      while (k < len && s[k] !== '`') k++;
      if (k < len) {
        j = k + countRun(s, k, '`');
        continue;
      }
      return -1;
    }
    j++;
  }
  return -1;
}
// ---- delimiter runs: flanking ----
// Returns bitmask: 1 = can open, 2 = can close, for a run src[i..j) of one
// delimiter char. prev = char code before i (-1 at start), next = char code
// after j (-1 at end). Unicode-aware punctuation via \p{P}|\p{S}.
function flankFlags(src, i, j) {
  const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
  const next = j < src.length ? src.charCodeAt(j) : -1;
  const prevWs = prev < 0 || isSpaceCode(prev);
  const nextWs = next < 0 || isSpaceCode(next);
  const prevPunct = prev >= 0 && isPunctCh(prev);
  const nextPunct = next >= 0 && isPunctCh(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  let f = 0;
  if (left) f |= 1;
  if (right) f |= 2;
  return f;
}
// `_` has the extra CommonMark restriction: canOpen needs left-flanking and
// (not right-flanking or preceded by punctuation); canClose needs
// right-flanking and (not left-flanking or followed by punctuation).
// `*` and `~` use the plain left/right rule.
function openCloseFlags(src, i, j, ch) {
  const f = flankFlags(src, i, j);
  if (ch !== 95) return f;
  const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
  const next = j < src.length ? src.charCodeAt(j) : -1;
  const prevPunct = prev >= 0 && isPunctCh(prev);
  const nextPunct = next >= 0 && isPunctCh(next);
  const o = (f & 1) && (!(f & 2) || prevPunct);
  const c = (f & 2) && (!(f & 1) || nextPunct);
  return (o ? 1 : 0) | (c ? 2 : 0);
}

// Collect every run of char code ch in src starting at or after `from`.
// Returns array of [pos, len, flags]. `mask` (Uint8Array or null) marks
// positions hidden from delimiter scanning (inside code spans, formable
// links/images, autolinks, raw tags, or escaped); a masked position breaks
// a run. Flanking is still computed on the raw string.
function collectRuns(src, from, ch, mask) {
  const runs = [];
  const n = src.length;
  let j = from;
  while (j < n) {
    let k = j;
    while (k < n && (src.charCodeAt(k) !== ch || (mask && mask[k]))) k++;
    if (k >= n) break;
    let m = k;
    while (m < n && src.charCodeAt(m) === ch && !(mask && mask[m])) m++;
    runs.push([k, m - k, openCloseFlags(src, k, m, ch)]);
    j = m;
  }
  return runs;
}

// Opener-driven emphasis scan. src is the inline string, i the opener run
// start, L the opener run length, ch the delimiter char code (42 '*' or
// 95 '_'). Returns null when no closer, else {cp, p, r, tOpen, tBoth, skip}
// where cp is the closer char position, [p, p+r) the closer run, and the
// tallies/skip count place the closer char and build the token text.
// Model (derived by probing marked 18.1.3): two tallies — tOpen counts
// open-only runs (real openers that must be closed first), tBoth counts
// both-flanking runs treated as openers. A both-flanking run is an opener
// when a later closable run exists and L > 1, else a closer. Rule of three
// blocks a closer when (L+r)%3==0 and (opener or run can both) and not
// (L%3==0 and r%3==0). A both-flanking tally is consumed only when
// (L+tBoth)%3==0.
// Is the delimiter run starting at k (char ch) enclosed by a pair of
// the OTHER delimiter char (e.g. a `*` run inside a `__...__` strong)?
// A run inside such a pair cannot claim the outer closer: the pair's
// closer sits between the run and the outer closer. The nearest
// other-char run before k must be an opener whose closer lies past k.
function insideOtherPair(src, k, r, ch, mask, depth) {
  if (depth > 0) return false; // no nested cross-checks
  const och = ch === 42 ? 95 : 42;
  let j = k - 1;
  while (j >= 0 && (src.charCodeAt(j) !== och || (mask && mask[j]))) j--;
  if (j < 0) return false;
  let a = j;
  while (a > 0 && src.charCodeAt(a - 1) === och && !(mask && mask[a - 1])) a--;
  const fl = openCloseFlags(src, a, j + 1, och);
  if (!(fl & 1)) return false; // nearest other-char run cannot open
  const hit = emScan(src, a, j - a + 1, och, mask, depth + 1);
  if (!hit || hit.p <= k) return false;
  // The run sits inside the other pair — but it still claims a closer
  // when one lies between it and the other pair's closer (e.g. the `**`
  // before `c` in `*a __b **c** d__*` pairs with the `**` after `c`
  // inside the `__` pair). Only a run with no closer of its own inside
  // the pair (cm-470's `*baz`) cannot claim the outer closer at all.
  const runs = collectRuns(src, k + r, ch, mask);
  for (const [rk, rr, rf] of runs) {
    if (rk >= hit.p) break;
    if (rf & 2) return false;
  }
  return true;
}

function emScan(src, i, L, ch, mask, depth) {
  const openerFlags = openCloseFlags(src, i, i + L, ch);
  const openerBoth = (openerFlags & 3) === 3;
  const runs = collectRuns(src, i + L, ch, mask);
  let tOpen = 0, tBoth = 0;
  let best = null;
  for (let ri = 0; ri < runs.length; ri++) {
    const [k, r, fl] = runs[ri];
    const canOpen = (fl & 1) !== 0, canClose = (fl & 2) !== 0;
    if (!canOpen && !canClose) continue;
    if (canClose) {
      if ((L + r) % 3 === 0 && (openerBoth || (fl & 3) === 3) && !(L % 3 === 0 && r % 3 === 0)) {
        // Blocked by the rule of three: this run cannot pair with the
        // opener, so it claims no closer chars and is not an opener.
        continue;
      }
      if (tOpen >= r) { tOpen -= r; continue; }
      if (tBoth >= r && ((L + tBoth) % 3 === 0 || (L + r) % 3 === 0)) { tBoth -= r; continue; }
      // Both-flanking run: it closes the opener only when its length
      // matches the opener's; otherwise (and when a later closable run
      // exists and L > 1) it acts as an opener.
      if ((fl & 3) === 3 && r !== L && L > 1) {
        let later = false;
        for (let q = ri + 1; q < runs.length; q++) { if (runs[q][2] & 2) { later = true; break; } }
        if (later) { tBoth += r; continue; }
      }
      // Valid closer candidate. An exact-length match (r === L) closes
      // the opener at once; a run of a different length may be an inner
      // opener's closer instead, so it is only a candidate and the last
      // valid closer wins — unless this run already has enough chars
      // left (after the inner openers claim theirs) to close the opener
      // fully, in which case it is the closer and a later run (which
      // belongs to a separate emphasis) must not steal it.
      const cp = k + Math.min(tOpen + tBoth, r - 1);
      if (r === L) return { cp, p: k, r, tOpen, tBoth };
      if (r - (cp - k) >= L) return { cp, p: k, r, tOpen, tBoth };
      best = { cp, p: k, r, tOpen, tBoth };
      continue;
    }
    // Open-only run: it claims the closer chars that follow it, unless
    // it sits inside a pair of the other delimiter char (then it cannot
    // claim the outer closer at all).
    if (!insideOtherPair(src, k, r, ch, mask, depth || 0)) tOpen += r;
  }
  return best;
}

// Del scan: opener-driven, no rule of three. Only runs of exactly the
// opener's length count (as openers in the tally or as closers); other
// lengths are skipped. Returns {cp, p, r} or null.
function delScan(src, i, L, mask) {
  const runs = collectRuns(src, i + L, 126, mask);
  let tally = 0;
  for (const [k, r, fl] of runs) {
    if (r !== L) continue;
    const canOpen = (fl & 1) !== 0, canClose = (fl & 2) !== 0;
    if (!canOpen && !canClose) continue;
    if (canClose) {
      if (tally > 0) { tally--; continue; }
      return { cp: k, p: k, r };
    }
    tally++;
  }
  return null;
}

// ---- emphasis / del token construction ----
// Given an opener run [i, i+L) and a scan hit, build the token. `render` is
// the inline renderer for the inner text. Returns {end, html} where end is
// the exclusive end of the token span in src. The leftover opener chars
// that do not pair with content are emitted as literal text before the tag;
// the leftover closer chars after the span end are left for the caller.
function buildEm(src, i, L, hit, ch, render, refs) {
  const { cp, p, r } = hit;
  // Closer chars claimed by inner openers (tally) shrink the run the tag
  // itself can use: k = min(L, r - claimed). Decompose k into nested tags
  // (odd k -> one em outside, the rest strongs), as marked does.
  const claimed = cp - p;
  const k = Math.min(L, r - claimed);
  const leftN = L - k;
  const content = src.slice(i + L, p);
  // Content runs of this delimiter char (masked positions excluded).
  const contentMask = buildMask(content, refs);
  const cRuns = collectRuns(content, 0, ch, contentMask);
  let bestClose = 0, bestOpen = 0, closePos = -1, openPos = -1;
  let hasOpen = false, hasClose = false;
  for (const [, , rf] of cRuns) {
    if (rf & 1) hasOpen = true;
    if (rf & 2) hasClose = true;
  }
  if (hasOpen && hasClose) {
    // A content opener is matched when its own scan lands on a closer in
    // the content; a content run is matched as a closer when some opener's
    // scan lands on it. Only an opener unmatched in both senses needs the
    // outer closer's chars, and only a closer unmatched inside the content
    // can pair with a leftover opener char.
    const usedClose = new Set();
    const matchedOpen = new Set();
    for (const [rp, rl, rf] of cRuns) {
      if (!(rf & 1)) continue;
      const h = emScan(content, rp, rl, ch, contentMask, 0);
      if (h) { usedClose.add(h.p); matchedOpen.add(rp); }
    }
    for (const [rp, rl, rf] of cRuns) {
      if ((rf & 2) && !usedClose.has(rp) && rl > bestClose) { bestClose = rl; closePos = rp; }
      if ((rf & 1) && !usedClose.has(rp) && !matchedOpen.has(rp) && rl > bestOpen) { bestOpen = rl; openPos = rp; }
    }
  } else {
    // No opener can be matched without a closer in the content (and no
    // closer can be spent without an opener), so the plain longest runs
    // are exact here and the scans are skipped.
    for (const [rp, rl, rf] of cRuns) {
      if ((rf & 2) && rl > bestClose) { bestClose = rl; closePos = rp; }
      if ((rf & 1) && rl > bestOpen) { bestOpen = rl; openPos = rp; }
    }
  }
  // Leftover opener chars pair inside the tag when the content has a
  // close-only run for them, or when L === r and no content opener claims
  // the closer chars (so the leftovers pair with each other).
  const leftPairs = leftN > 0 && (bestClose >= 1 || (L === r && bestOpen === 0));
  // The closer run pairs with a content opener run that the leftover
  // opener did not already claim (same run cannot serve both).
  const rightPairs = L === r || (bestOpen >= 1 && !(leftPairs && L !== r && closePos === openPos && closePos >= 0));
  let rightLen;
  if (rightPairs) rightLen = Math.max(cp - p, Math.min(r - k, bestOpen));
  else rightLen = cp - p;
  let text = content;
  if (leftPairs) text = src.slice(i, i + leftN) + text;
  if (rightLen > 0) text += src.slice(p, p + rightLen);
  const inner = render(text);
  // Decompose k into nested tags, innermost first: the strongs are
  // inside, and the odd leftover char (em) is the outermost tag.
  let html = inner;
  let rem = k;
  while (rem >= 2) { html = '<strong>' + html + '</strong>'; rem -= 2; }
  if (rem === 1) { html = '<em>' + html + '</em>'; }
  const lit = leftPairs ? '' : escText(src.slice(i, i + leftN));
  const end = p + rightLen + k;
  return { end, html: lit + html };
}

// Del token: closer run length equals opener length, so the text is the
// plain content; leftover chars (when the closer char is not the run start)
// are literal inside the del text. Returns {end, html}.
function buildDel(src, i, L, hit, render) {
  const { cp, p, r } = hit;
  const text = src.slice(i + L, p) + src.slice(p, cp);
  const inner = render(text);
  return { end: p + r, html: '<del>' + inner + '</del>' };
}

// ---- link destination / title parsing ----
// Parse a link destination starting at src[i] (after the opening '(' or
// after the link text). Returns {dest, next} where next is the index just
// past the destination, or null. dest is the raw (unescaped) destination.
function parseDest(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  if (src.charCodeAt(j) === 60) { // '<...>'
    let k = j + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 62) return { dest: src.slice(j + 1, k), next: k + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && k + 1 < n) k++;
      k++;
    }
    return null;
  }
  // Bare destination: balanced parens, escapes, no spaces/control.
  // An empty destination is allowed: [link]() has href="".
  let depth = 0;
  let k = j;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92 && k + 1 < n) { k += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    k++;
  }
  return { dest: src.slice(j, k), next: k };
}

// Parse a link title starting at src[i] (after the destination + space).
// Returns {title, next} or null. Title delimiters: "...", '...', (...).
function parseTitle(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  const c = src.charCodeAt(j);
  let open, close;
  if (c === 34) { open = 34; close = 34; }
  else if (c === 39) { open = 39; close = 39; }
  else if (c === 40) { open = 40; close = 41; }
  else return null;
  let k = j + 1;
  while (k < n) {
    const cc = src.charCodeAt(k);
    if (cc === close) return { title: src.slice(j + 1, k), next: k + 1 };
    if (cc === 92 && k + 1 < n && (open !== 40 || src.charCodeAt(k + 1) === 41 || src.charCodeAt(k + 1) === 40)) k++;
    k++;
  }
  return null;
}

// Unescape backslash escapes and decode entities in a link destination /
// title (after the raw dest/title is extracted).
function unescapeDest(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && ESCAPABLE.has(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; continue; }
    if (c === 38) {
      const d = decodeNumericAt(s, i);
      if (d) { out += d.ch; i = d.next - 1; continue; }
    }
    out += s[i];
  }
  return out;
}

// The Be() guard: reject a link whose text contains an unterminated tag
// or autolink extending past the text end. `textStart` is the index of the
// first text char in src; `lt` is the index of the `]` closing the text.
// The last '<' in the text starts a tag/autolink in the full src; if it
// ends past the ']', the text is open and the link is rejected.
function linkTextHasOpenTag(src, textStart, lt) {
  const text = src.slice(textStart, lt);
  const pos = text.lastIndexOf('<');
  if (pos < 0) return false;
  const e = angleEnd(src, textStart + pos);
  return e > 0 && e > lt;
}

// ---- inline rendering ----
// Plain-text rendering of a string (for image alt text): strips emphasis
// delimiters, code-span backticks, link/image syntax, keeping inner text.
function plainText(s, refs) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && ESCAPABLE.has(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
    if (c === 96) {
      const openLen = countRun(s, i, 96);
      const e = codeSpanEnd(s, i, openLen);
      if (e >= 0) {
        out += s.slice(i + openLen, e - openLen).replace(/\n/g, ' ');
        i = e; continue;
      }
      out += '`'; i++; continue;
    }
    if (c === 60) {
      const t = matchTag(s, i);
      if (t) { i += t; continue; }
      out += '&lt;'; i++; continue;
    }
    if (c === 38) {
      const d = decodeNumericAt(s, i);
      if (d) { out += d.ch; i = d.next; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 42 || c === 95 || c === 126) { i++; continue; }
    if (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91) {
      // An image inside alt text contributes its own alt text (no '!').
      const f = linkForm(s, i, true, refs);
      if (f) { out += plainText(f.text, refs); i = f.end; continue; }
      out += '!'; i++; continue;
    }
    if (c === 91) {
      // A formable link/image contributes its text (recursively); an
      // unformable '[' is literal and the scan continues inside it.
      const f = linkForm(s, i, false, refs);
      if (f) { out += plainText(f.text, refs); i = f.end; continue; }
      out += '['; i++; continue;
    }
    if (c === 93) { out += ']'; i++; continue; }
    if (c === 10) { out += ' '; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}

// Does the string contain a formable markdown link (for the De() guard:
// a nested link drops the outer link)? Checks for '[' + link text + ']' +
// '(' or '[' with a valid destination / reference.
function containsLink(s, refs) {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) !== 91) continue;
    // A '[' preceded by '!' is an image, not a link. Skip the image and
    // a reference label that follows it immediately: ![a][b] is one
    // image, and [b] is its label, not a separate link.
    if (i > 0 && s.charCodeAt(i - 1) === 33) {
      const lt2 = scanLinkText(s, i);
      if (lt2 >= 0 && lt2 + 1 < n && s.charCodeAt(lt2 + 1) === 91) {
        const lb = scanRefLabel(s, lt2 + 1);
        if (lb >= 0) { i = lb; continue; }
      }
      continue;
    }
    const lt = scanLinkText(s, i);
    if (lt < 0) continue;
    const after = lt + 1;
    if (after < n && s.charCodeAt(after) === 40) {
      const d = parseDest(s, after + 1);
      if (d) {
        let k = d.next;
        while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
        if (k < n && s.charCodeAt(k) === 41) return true;
        const t = parseTitle(s, k);
        if (t) {
          let m = t.next;
          while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9 || s.charCodeAt(m) === 10)) m++;
          if (m < n && s.charCodeAt(m) === 41) return true;
        }
      }
      continue;
    }
    if (after < n && s.charCodeAt(after) === 91) {
      const lb = scanRefLabel(s, after);
      if (lb < 0) {
        // Not a valid label: fall back to the shortcut form.
        if (refs && refs.has(normLabel(s.slice(i + 1, lt)))) return true;
      } else {
        const label = lb === after + 1 ? s.slice(i + 1, lt) : s.slice(after + 1, lb);
        if (refs && refs.has(normLabel(label))) return true;
      }
      continue;
    }
    // Shortcut reference link.
    if (refs && refs.has(normLabel(s.slice(i + 1, lt)))) return true;
  }
  return false;
}

// Formability check for a link or image starting at src[i] ('[' or
// '!['). Returns {end, text, href, title} (href/title unescaped) or null.
// Guards (links only): Be() (unterminated tag in text), De() (a nested
// link in the text). If the inline `(...)` form fails, the shortcut
// reference form (label = text) is tried.
function linkForm(src, i, isImage, refs) {
  const n = src.length;
  const textStart = i + (isImage ? 2 : 1);
  const lt = scanLinkText(src, textStart - 1);
  if (lt < 0) return null;
  const text = src.slice(textStart, lt);
  const after = lt + 1;
  if (!isImage) {
    if (linkTextHasOpenTag(src, textStart, lt)) return null;
    if (containsLink(text, refs)) return null;
  }
  // Inline link: (dest "title").
  if (after < n && src.charCodeAt(after) === 40) {
    const d = parseDest(src, after + 1);
    if (d) {
      let k = d.next;
      let title = null;
      while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
      if (k < n && src.charCodeAt(k) !== 41) {
        const t = parseTitle(src, k);
        if (t) {
          title = t.title;
          k = t.next;
          while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
        }
      }
      if (k < n && src.charCodeAt(k) === 41) {
        return { end: k + 1, text, href: unescapeDest(d.dest), title: title === null ? null : unescapeDest(title) };
      }
    }
    // Inline form failed: fall through to the shortcut reference form.
  }
  // Reference link: [text][label], [text][] or [text]. When the [label]
  // is not a valid label (it holds an unescaped '[' or an unclosed code
  // span), the shortcut form (label = text) is tried instead; when the
  // label scans but has no definition, there is no fallback.
  let label = null, refEnd = after;
  if (after < n && src.charCodeAt(after) === 91) {
    const lb = scanRefLabel(src, after);
    if (lb < 0) {
      label = text;
      refEnd = after;
    } else {
      label = lb === after + 1 ? text : src.slice(after + 1, lb);
      refEnd = lb + 1;
    }
  } else {
    label = text;
    refEnd = after;
  }
  if (!label) return null;
  const ref = refs ? refs.get(normLabel(label)) : undefined;
  if (!ref) return null;
  return { end: refEnd, text, href: ref.href, title: ref.title };
}

// End index of a formable link/image starting at src[i], or 0. Used by
// the delimiter mask (a formable construct hides its inner delimiters).
function linkEnd(src, i, isImage, refs) {
  const f = linkForm(src, i, isImage, refs);
  return f ? f.end : 0;
}

// Try to form a link or image starting at src[i] ('[' or '!['). Returns
// {end, html} or null. `isImage` distinguishes ![...] from [...].
// The link text is rendered in its own scope (linkState null): a raw
// `<a>` tag inside it does not touch the document's inLink state.
function tryLink(src, i, isImage, refs, ctx) {
  const f = linkForm(src, i, isImage, refs);
  if (!f) return null;
  let hrefOut;
  try { hrefOut = escText(encodeHref(f.href)); } catch (e) { return null; }
  const tAttr = f.title !== null ? ' title="' + escText(f.title) + '"' : '';
  if (isImage) {
    const alt = escAll(plainText(f.text, refs));
    return { end: f.end, html: '<img src="' + hrefOut + '" alt="' + alt + '"' + tAttr + '>' };
  }
  const inner = renderInline(f.text, refs, true, ctx, null);
  return { end: f.end, html: '<a href="' + hrefOut + '"' + tAttr + '>' + inner + '</a>' };
}

// End index (exclusive) of the raw tag or `<...>` autolink starting at
// src[i], or 0 when there is none. Shared by tryAngle, the Be() guard,
// and the delimiter mask. Scheme autolinks are tried before email ones.
function angleEnd(src, i) {
  const m = matchTag(src, i);
  if (m) return i + m;
  const n = src.length;
  // Scheme autolink: <scheme:...> with scheme >= 2 chars.
  const c0 = i + 1;
  let k = c0;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 58) break;
    if (!(isAlnumCh(c) || c === 46 || c === 45 || c === 43)) { k = -1; break; }
    k++;
  }
  if (k > 0 && k - c0 >= 2 && k < n && src.charCodeAt(k) === 58) {
    let e = k + 1;
    while (e < n && src.charCodeAt(e) !== 62) {
      const c = src.charCodeAt(e);
      if (c === 32 || c === 10 || c === 60) { e = -1; break; }
      e++;
    }
    if (e > 0 && e < n && e > k + 1) return e + 1;
  }
  // Email autolink: <local@domain.tld>.
  let at = -1;
  let j = i + 1;
  while (j < n && src.charCodeAt(j) !== 62 && src.charCodeAt(j) !== 32 && src.charCodeAt(j) !== 10) {
    if (src.charCodeAt(j) === 64) { at = j; break; }
    j++;
  }
  if (at > i + 1) {
    let e = at + 1;
    let dot = false;
    while (e < n && src.charCodeAt(e) !== 62) {
      const c = src.charCodeAt(e);
      if (c === 46) dot = true;
      if (!(isAlnumCh(c) || c === 45 || c === 46 || c === 95)) break;
      e++;
    }
    if (dot && e < n && src.charCodeAt(e) === 62 && e > at + 2) {
      const email = src.slice(i + 1, e);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email)) return e + 1;
    }
  }
  return 0;
}

// Autolink <...> or raw tag starting at src[i] ('<'). Returns {end, html}
// or null (not an autolink/tag).
function tryAngle(src, i, ctx) {
  const m = matchTag(src, i);
  if (m) {
    const tag = src.slice(i, i + m);
    const name = tagNameOf(tag);
    if (name) {
      // Inside a raw inline element (pre/code/kbd/script) entities are
      // not decoded; a close tag (or self-closing tag) ends that state.
      if (RAW_INLINE.has(name)) ctx.raw = tag[1] !== '/' && !tag.endsWith('/>');
      else ctx.raw = false;
    }
    return { end: i + m, html: tag };
  }
  // Autolink: <scheme:...> or <email> (scheme first).
  const n = src.length;
  const c0 = i + 1;
  let k = c0;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 58) break;
    if (!(isAlnumCh(c) || c === 46 || c === 45 || c === 43)) { k = -1; break; }
    k++;
  }
  if (k > 0 && k - c0 >= 2 && k < n && src.charCodeAt(k) === 58) {
    let e = k + 1;
    while (e < n && src.charCodeAt(e) !== 62) {
      const c = src.charCodeAt(e);
      if (c === 32 || c === 10 || c === 60) { e = -1; break; }
      e++;
    }
    if (e > 0 && e < n && e > k + 1) {
      const url = src.slice(i + 1, e);
      let hrefOut;
      try { hrefOut = escText(encodeHref(url)); } catch (err) { return null; }
      return { end: e + 1, html: '<a href="' + hrefOut + '">' + escAll(url) + '</a>' };
    }
    return null;
  }
  // Email: local@domain with a dot in the domain.
  let at = -1;
  let j = i + 1;
  while (j < n && src.charCodeAt(j) !== 62 && src.charCodeAt(j) !== 32 && src.charCodeAt(j) !== 10) {
    if (src.charCodeAt(j) === 64) { at = j; break; }
    j++;
  }
  if (at > i + 1) {
    let e = at + 1;
    let dot = false;
    while (e < n && src.charCodeAt(e) !== 62) {
      const c = src.charCodeAt(e);
      if (c === 46) dot = true;
      if (!(isAlnumCh(c) || c === 45 || c === 46 || c === 95)) break;
      e++;
    }
    if (dot && e < n && src.charCodeAt(e) === 62 && e > at + 2) {
      const email = src.slice(i + 1, e);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email)) {
        const en = escAll(email);
        return { end: e + 1, html: '<a href="mailto:' + en + '">' + en + '</a>' };
      }
    }
  }
  return null;
}

// ---- bare URL / email (GFM extended autolinks) ----
// Scan a bare URL starting at src[i]. Returns {end, url} or null. `end`
// is just past the URL after backpedalling trailing punctuation.
// Backpedal loop (probed against marked 18.1.3), repeated until stable,
// in order: (a) a trailing entity tail `&name;` is stripped whole;
// (b) one trailing punctuation char in `?!.,:;*_'"~`; (c) a trailing `)`
// is stripped iff more than one `)` follows the last `(`; (d) an unclosed
// `(` group is stripped from the last `(` to the end.
function scanBareUrl(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 10 || c === 60 || c === 9) break;
    j++;
  }
  if (j === i) return null;
  let end = j;
  for (;;) {
    if (end <= i) return null;
    const c = src.charCodeAt(end - 1);
    // (a) Entity tail: &name; at the end is stripped whole (the name
    // must be non-empty alphanumerics).
    if (c === 59) { // ';'
      let k = end - 2;
      while (k >= i && isAlnumCh(src.charCodeAt(k))) k--;
      if (k >= i && src.charCodeAt(k) === 38 && k < end - 2) { end = k; continue; }
      end--; continue;
    }
    // (b) Trailing punctuation.
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
        c === 42 || c === 95 || c === 39 || c === 34 || c === 126) { end--; continue; }
    // (c) Trailing ')': strip one iff more than one ')' follows the last
    // '('; with no '(' in the URL the ')' is unbalanced and is stripped.
    if (c === 41) {
      let lastOpen = -1;
      for (let k = i; k < end; k++) if (src.charCodeAt(k) === 40) lastOpen = k;
      if (lastOpen < 0) { end--; continue; }
      let closes = 0;
      for (let k = lastOpen + 1; k < end; k++) if (src.charCodeAt(k) === 41) closes++;
      if (closes > 1) { end--; continue; }
      break;
    }
    // (d) Unclosed '(' group: strip from the last '(' to the end.
    let lastOpen = -1;
    for (let k = i; k < end; k++) if (src.charCodeAt(k) === 40) lastOpen = k;
    if (lastOpen >= 0) {
      let hasClose = false;
      for (let k = lastOpen + 1; k < end; k++) if (src.charCodeAt(k) === 41) { hasClose = true; break; }
      if (!hasClose) { end = lastOpen; continue; }
    }
    break;
  }
  if (end === i) return null;
  return { end, url: src.slice(i, end) };
}

// Scan an email starting at the '@' (src[i] === '@'). `back` is the index
// in `buf` where the local part may start (buf is the pending text run).
// Returns {start, end, email} where start is the offset into buf, or null.
// Domain: labels of [alnum_-]+ separated by '.', at least one dot, labels
// non-empty; the TLD may be one char and alnum. If the domain scan ends on
// '-' or '_' the WHOLE email fails (it is not truncated).
function scanEmail(src, i, buf) {
  const n = src.length;
  // Local part: scan back through buf.
  let s = buf.length;
  while (s > 0) {
    const c = buf.charCodeAt(s - 1);
    if (isAlnumCh(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
        c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 ||
        c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
        c === 125 || c === 126 || c === 45) { s--; continue; }
    break;
  }
  if (s === buf.length) return null; // empty local part
  // Domain labels.
  let j = i + 1;
  let dot = false;
  let first = true;
  while (j < n) {
    const ls = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isAlnumCh(c) || c === 45 || c === 95) { j++; continue; }
      break;
    }
    if (j === ls) {
      if (first) return null; // empty first label: a@.b.c
      break; // trailing '.' ends the domain: a@b.c.
    }
    first = false;
    if (j < n && src.charCodeAt(j) === 46) {
      // '.' continues the domain only when followed by a label char.
      if (j + 1 < n && (isAlnumCh(src.charCodeAt(j + 1)) || src.charCodeAt(j + 1) === 45 || src.charCodeAt(j + 1) === 95)) {
        dot = true;
        j++;
        continue;
      }
      break;
    }
    break;
  }
  if (!dot) return null;
  // The domain's last char must be alnum; a trailing '-'/'_' fails all.
  if (!isAlnumCh(src.charCodeAt(j - 1))) return null;
  const dom = src.slice(i + 1, j);
  return { start: s, end: j, email: buf.slice(s) + '@' + dom };
}

// Strict-label scan for the delimiter mask: find the end (exclusive) of a
// `[...](...)` construct starting at src[i] ('[' or '!['), or 0 when there
// is none. This mirrors marked's blockSkip: the label holds no unescaped
// '[' (a '[' inside a complete code span does not count) and a backtick
// run must form a complete code span with strict same-length pairing
// (an unmatched run fails the scan); the parens are balanced with `\`
// escapes skipped and no code-span awareness. The construct is masked
// even when the real link regex rejects it (e.g. a destination with a
// space), so emphasis inside it does not form at the top level.
function strictLabelEnd(src, i, isImage) {
  const n = src.length;
  let j = i + (isImage ? 2 : 1);
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return 0; // unescaped '[' in the label
    if (c === 93) break; // label closes
    if (c === 96) {
      const L = countRun(src, j, 96);
      const e = codeSpanEnd(src, j, L);
      if (e < 0) return 0; // unmatched backtick run: not a label
      j = e;
      continue;
    }
    j++;
  }
  if (j >= n || src.charCodeAt(j) !== 93) return 0;
  if (j + 1 >= n || src.charCodeAt(j + 1) !== 40) return 0;
  // Balanced parens after the label.
  let depth = 1;
  let k = j + 2;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 40) { depth++; k++; continue; }
    if (c === 41) {
      depth--;
      if (depth === 0) return k + 1;
      k++;
      continue;
    }
    k++;
  }
  return 0;
}

// Mask of positions hidden from em/del scanning: inside complete code
// spans, formable inline/reference links and images, `<...>` autolinks
// and raw tags, and escaped delimiter chars. Flanking is computed on the
// raw string; only the delimiter-run collection consults the mask. The
// mask is built lazily per renderInline call (only when a delimiter run
// is met) and cached for that call. Two passes, in marked's order: the
// backtick runs pair left to right first (a run inside a link text can
// pair with a later run outside the link, hiding the text between them
// from emphasis), then links and tags are masked in the regions not
// already covered.
function buildMask(src, refs) {
  const n = src.length;
  const mask = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92 && i + 1 < n && ESCAPABLE.has(src.charCodeAt(i + 1))) {
      mask[i + 1] = 1;
      i += 2;
      continue;
    }
    if (c === 96) {
      const L = countRun(src, i, 96);
      const e = codeSpanEnd(src, i, L);
      if (e >= 0) { mask.fill(1, i, e); i = e; continue; }
      i += L;
      continue;
    }
    i++;
  }
  i = 0;
  while (i < n) {
    if (mask[i]) { i++; continue; }
    const c = src.charCodeAt(i);
    if (c === 60) {
      const e = angleEnd(src, i);
      if (e > 0) { mask.fill(1, i, e); i = e; continue; }
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) {
      const e = linkEnd(src, i, true, refs);
      if (e > 0) { mask.fill(1, i, e); i = e; continue; }
      const se = strictLabelEnd(src, i, true);
      if (se > 0) { mask.fill(1, i, se); i = se; continue; }
      i++;
      continue;
    }
    if (c === 91) {
      const e = linkEnd(src, i, false, refs);
      if (e > 0) { mask.fill(1, i, e); i = e; continue; }
      const se = strictLabelEnd(src, i, false);
      if (se > 0) { mask.fill(1, i, se); i = se; continue; }
      i++;
      continue;
    }
    i++;
  }
  return mask;
}

// Scan a mailto:/xmpp: bare URL starting at src[i]. Returns {end, url}
// or null. The URL is scheme + email + an optional single /resource
// segment (no '/' inside it). If the email part is invalid (e.g. the
// domain ends on '-' or '_'), there is no link at all.
function scanMailtoUrl(src, i) {
  const n = src.length;
  const lower = src.slice(i, i + 7).toLowerCase();
  let schemeEnd;
  if (lower.startsWith('mailto:')) schemeEnd = i + 7;
  else if (lower.startsWith('xmpp:')) schemeEnd = i + 5;
  else return null;
  // Local part: scan forward (same char set as the bare-email back-scan).
  let j = schemeEnd;
  const ls = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnumCh(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
        c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 ||
        c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
        c === 125 || c === 126 || c === 45) { j++; continue; }
    break;
  }
  if (j === ls) return null;
  if (j >= n || src.charCodeAt(j) !== 64) return null;
  // Domain: same label rules as scanEmail.
  let k = j + 1;
  let dot = false;
  let first = true;
  while (k < n) {
    const ds = k;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isAlnumCh(c) || c === 45 || c === 95) { k++; continue; }
      break;
    }
    if (k === ds) {
      if (first) return null;
      break;
    }
    first = false;
    if (k < n && src.charCodeAt(k) === 46) {
      if (k + 1 < n && (isAlnumCh(src.charCodeAt(k + 1)) || src.charCodeAt(k + 1) === 45 || src.charCodeAt(k + 1) === 95)) {
        dot = true;
        k++;
        continue;
      }
      break;
    }
    break;
  }
  if (!dot) return null;
  if (!isAlnumCh(src.charCodeAt(k - 1))) return null;
  let end = k;
  // Optional /resource: one segment, no '/' inside, at least one char.
  if (end < n && src.charCodeAt(end) === 47) {
    let r = end + 1;
    while (r < n) {
      const c = src.charCodeAt(r);
      if (c === 32 || c === 10 || c === 60 || c === 9 || c === 47) break;
      r++;
    }
    if (r > end + 1) {
      let e2 = r;
      while (e2 > end + 1) {
        const c = src.charCodeAt(e2 - 1);
        if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
            c === 42 || c === 95 || c === 39 || c === 34 || c === 126) { e2--; continue; }
        break;
      }
      if (e2 > end + 1) end = e2;
    }
  }
  return { end, url: src.slice(i, end) };
}

// Is the line starting at src[i] non-blank (contains a non-space/tab)?
function nextLineNonBlank(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) !== 10) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return true;
    j++;
  }
  return false;
}

// Main inline renderer. Returns the HTML for src. refs is a Map of
// normalized label -> {href, title} (or null). inLink suppresses GFM
// bare-URL/email autolinking. ctx is {raw} (entity decoding suppression).
// linkState is the per-document {inLink} object (or null for a scoped
// render such as link text): marked carries the inLink state across the
// whole document — a raw `<a ` open tag in inline content sets it (bare
// autolinks after it are suppressed) until a raw `</a>` clears it. The
// tag must start with `<a ` (literal space); the close tag must be
// exactly `</a>`. Autolinks and markdown links are complete links and
// do not touch it.
function renderInline(src, refs, inLink, ctx, linkState) {
  const n = src.length;
  const out = [];
  let buf = '';
  let i = 0;
  // A raw tag token's effect on the document inLink state. `tag` is the
  // raw tag text as matched (autolinks are `<scheme:...>`/`<email>` and
  // never start with `<a `, so they are unaffected). Any open tag
  // starting with `<a ` (literal space) sets it — attributes or a
  // self-closing slash do not matter, and no href is needed; only the
  // exact close tag `</a>` clears it.
  const tagLinkState = (tag) => {
    if (!linkState) return;
    if (/^<a /i.test(tag)) linkState.inLink = true;
    else if (/^<\/a>$/i.test(tag)) linkState.inLink = false;
  };
  // Delimiter mask (code spans, links, tags, escapes) — built lazily on
  // the first emphasis/del attempt, only when a delimiter run is present.
  let mask = null;
  const getMask = () => {
    if (!mask) mask = buildMask(src, refs);
    return mask;
  };
  const flush = () => {
    if (buf) {
      out.push(escText(buf));
      buf = '';
    }
  };
  const pushDecoded = (ch) => {
    // A decoded numeric-ref char: escape it directly (it must not be
    // re-examined as an entity).
    if (ch === '&') out.push('&amp;');
    else if (ch === '<') out.push('&lt;');
    else if (ch === '>') out.push('&gt;');
    else if (ch === '"') out.push('&quot;');
    else if (ch === "'") out.push('&#39;');
    else out.push(ch);
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    // Backslash escape / hard break.
    if (c === 92) {
      if (i + 1 < n) {
        const nc = src.charCodeAt(i + 1);
        if (nc === 10) {
          if (nextLineNonBlank(src, i + 2)) {
            flush(); out.push('<br>'); i += 2;
            // The next line's leading spaces/tabs are stripped.
            while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
            continue;
          }
          buf += '\\'; i++; continue;
        }
        if (ESCAPABLE.has(nc)) {
          // An escaped char is its own token: flush the pending text and
          // emit it directly, so a later bare-email scan-back sees only
          // the text since this token boundary (e.g. foo\+@bar is not an
          // email). Chars needing HTML escaping go out as entities.
          const ec = src[i + 1];
          if (ec === '&') { flush(); out.push('&amp;'); }
          else if (ec === '<') { flush(); out.push('&lt;'); }
          else if (ec === '>') { flush(); out.push('&gt;'); }
          else if (ec === '"') { flush(); out.push('&quot;'); }
          else if (ec === "'") { flush(); out.push('&#39;'); }
          else { flush(); out.push(ec); }
          i += 2; continue;
        }
      }
      buf += '\\'; i++; continue;
    }
    // Code span.
    if (c === 96) {
      const openLen = countRun(src, i, 96);
      const e = codeSpanEnd(src, i, openLen);
      if (e >= 0) {
        let inner = src.slice(i + openLen, e - openLen).replace(/\n/g, ' ');
        if (inner.length >= 2 && inner.charCodeAt(0) === 32 && inner.charCodeAt(inner.length - 1) === 32 &&
            inner.trim().length > 0) inner = inner.slice(1, -1);
        flush(); out.push('<code>' + escAll(inner) + '</code>'); i = e; continue;
      }
      // No closer: the whole backtick run is literal text.
      buf += src.slice(i, i + openLen); i += openLen; continue;
    }
    // Image / link.
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) {
      const r = tryLink(src, i, true, refs, ctx);
      if (r) { flush(); out.push(r.html); i = r.end; continue; }
      buf += '!'; i++; continue;
    }
    if (c === 91) {
      const r = tryLink(src, i, false, refs, ctx);
      if (r) { flush(); out.push(r.html); i = r.end; continue; }
      buf += '['; i++; continue;
    }
    // Emphasis / del.
    if (c === 42 || c === 95) {
      const L = countRun(src, i, c === 42 ? '*' : '_');
      const fl = openCloseFlags(src, i, i + L, c);
      if (fl & 1) {
        const hit = emScan(src, i, L, c, getMask());
        if (hit) {
          const t = buildEm(src, i, L, hit, c, (s) => renderInline(s, refs, inLink, { raw: false }, linkState), refs);
          flush(); out.push(t.html); i = t.end; continue;
        }
      }
      // A failed opener consumes the whole run as literal text.
      buf += src.slice(i, i + L); i += L; continue;
    }
    if (c === 126) {
      const L = countRun(src, i, '~');
      // A run of 3+ tildes is not a del opener (a single '~' or '~~' is).
      if (L > 2) { buf += src.slice(i, i + L); i += L; continue; }
      const fl = flankFlags(src, i, i + L);
      if (fl & 1) {
        const hit = delScan(src, i, L, getMask());
        if (hit) {
          const t = buildDel(src, i, L, hit, (s) => renderInline(s, refs, inLink, { raw: false }, linkState));
          flush(); out.push(t.html); i = t.end; continue;
        }
      }
      buf += src.slice(i, i + L); i += L; continue;
    }
    // Autolink / tag.
    if (c === 60) {
      const r = tryAngle(src, i, ctx);
      if (r) { tagLinkState(src.slice(i, r.end)); flush(); out.push(r.html); i = r.end; continue; }
      flush(); out.push('&lt;'); i++; continue;
    }
    // Entity: numeric refs are decoded (unless inside a raw tag).
    if (c === 38) {
      if (!ctx.raw) {
        const d = decodeNumericAt(src, i);
        if (d) { flush(); pushDecoded(d.ch); i = d.next; continue; }
      }
      buf += '&'; i++; continue;
    }
    // Hard break (2+ trailing spaces) / soft break.
    if (c === 10) {
      // Count trailing spaces in buf (a tab breaks the run).
      let sp = 0;
      let k = buf.length;
      while (k > 0 && buf.charCodeAt(k - 1) === 32) { sp++; k--; }
      if (sp >= 2 && nextLineNonBlank(src, i + 1)) {
        buf = buf.slice(0, buf.length - sp);
        flush(); out.push('<br>'); i++;
        // The next line's leading spaces/tabs are stripped.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      buf += '\n'; i++; continue;
    }
    // GFM bare URL / email (not inside a link). The suppression flag is
    // the live document state when shared, else the call's own flag.
    if (!(linkState ? linkState.inLink : inLink)) {
      if (c === 119 && src.startsWith('www.', i)) { // 'w'
        const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
        if (prev < 0 || isSpaceCode(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
          const u = scanBareUrl(src, i);
          if (u) {
            let hrefOut;
            try { hrefOut = escText(encodeHref('http://' + u.url)); } catch (e) { hrefOut = null; }
            if (hrefOut !== null) {
              flush(); out.push('<a href="' + hrefOut + '">' + escAll(u.url) + '</a>'); i = u.end; continue;
            }
          }
        }
      } else if ((c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77 || c === 120 || c === 88) &&
                 ((c === 104 || c === 72 || c === 102 || c === 70) ? (src.charCodeAt(i + 1) === 116 || src.charCodeAt(i + 1) === 84)
                  : (c === 109 || c === 77) ? (src.charCodeAt(i + 1) === 97 || src.charCodeAt(i + 1) === 65)
                  : (src.charCodeAt(i + 1) === 109 || src.charCodeAt(i + 1) === 77))) {
        // http(s)://, ftp:// — a generic URL (scanBareUrl).
        const rest = src.slice(i, i + 8).toLowerCase();
        const isHttp = rest.startsWith('http://') || rest.startsWith('https://');
        const isFtp = rest.startsWith('ftp://');
        if (isHttp || isFtp) {
          const u = scanBareUrl(src, i);
          if (u) {
            let hrefOut;
            try { hrefOut = escText(encodeHref(u.url)); } catch (e) { hrefOut = null; }
            if (hrefOut !== null) {
              flush(); out.push('<a href="' + hrefOut + '">' + escAll(u.url) + '</a>'); i = u.end; continue;
            }
          }
        } else {
          // mailto:/xmpp: — scheme + email + optional /resource.
          const u = scanMailtoUrl(src, i);
          if (u) {
            let hrefOut;
            try { hrefOut = escText(encodeHref(u.url)); } catch (e) { hrefOut = null; }
            if (hrefOut !== null) {
              flush(); out.push('<a href="' + hrefOut + '">' + escAll(u.url) + '</a>'); i = u.end; continue;
            }
          }
        }
      } else if (c === 64) { // '@' — email scan-back
        const em = scanEmail(src, i, buf);
        if (em) {
          buf = buf.slice(0, em.start);
          flush();
          const e2 = escAll(em.email);
          out.push('<a href="mailto:' + e2 + '">' + e2 + '</a>');
          i = em.end; continue;
        }
      }
    }
    buf += src[i]; i++;
  }
  flush();
  return out.join('');
}


// ---- block lexer ----
// A line view: raw text (no trailing \n) plus its indent in columns
// (a tab counts to the next multiple of 4) and the string index where
// non-space content begins.
function lineInfo(raw) {
  let indent = 0, i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { indent += 4 - (indent % 4); i++; }
    else break;
  }
  return { raw, indent, contentStart: i };
}
// Strip a fenced code block's indent from a content line the way
// marked's indent compensation does: remove up to `n` leading
// whitespace CHARACTERS (a tab counts as one character, not four), so
// a tab-indented line loses the tab instead of leaving spaces behind.
function stripFenceIndent(line, n) {
  const m = /^\s+/.exec(line);
  if (!m) return line;
  return line.slice(Math.min(m[0].length, n));
}

// Strip `cols` columns of leading indent from a line (tabs expand to 4).
function stripIndent(raw, cols) {
  let indent = 0, i = 0;
  const n = raw.length;
  while (i < n && indent < cols) {
    const c = raw.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { const w = 4 - (indent % 4); if (indent + w > cols) break; indent += w; i++; }
    else break;
  }
  // A tab that straddles the boundary becomes spaces.
  if (i < n && raw.charCodeAt(i) === 9 && indent < cols) {
    return ' '.repeat(cols - indent) + raw.slice(i + 1);
  }
  return raw.slice(i);
}

// Expand the leading whitespace of raw[startIdx..] to spaces, using the
// ORIGINAL columns (startCol is the column of raw[startIdx]). Tabs after
// the first non-whitespace char are preserved.
function expandLeading(raw, startIdx, startCol) {
  let col = startCol, i = startIdx;
  const n = raw.length;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return ' '.repeat(col - startCol) + raw.slice(i);
}

// Like stripIndent, but the remainder's leading whitespace is expanded
// to spaces using the ORIGINAL columns (so a tab keeps its width when
// the line is re-based for re-lexing). Used for blockquote / list-item
// content lines, whose leading whitespace is structure, not content.
// Tabs after the first non-whitespace char are preserved.
function stripIndentExpanded(raw, cols) {
  let indent = 0, i = 0;
  const n = raw.length;
  while (i < n && indent < cols) {
    const c = raw.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { const w = 4 - (indent % 4); if (indent + w > cols) break; indent += w; i++; }
    else break;
  }
  if (i < n && raw.charCodeAt(i) === 9 && indent < cols) {
    // A tab straddles the boundary: the part past `cols` becomes
    // leading spaces of the content (width indent+w-cols).
    const w = 4 - (indent % 4);
    return ' '.repeat(indent + w - cols) + expandLeading(raw, i + 1, indent + w);
  }
  return expandLeading(raw, i, indent);
}

// Return the content of raw starting at column targetCol, where the
// region to strip begins at (fromIdx, fromCol). Leading whitespace is
// expanded to spaces on original columns.
function stripToCol(raw, fromIdx, fromCol, targetCol) {
  let col = fromCol, i = fromIdx;
  const n = raw.length;
  while (i < n && col < targetCol) {
    const c = raw.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); if (col + w > targetCol) break; col += w; i++; }
    else break;
  }
  if (i < n && raw.charCodeAt(i) === 9 && col < targetCol) {
    const w = 4 - (col % 4);
    return ' '.repeat(col + w - targetCol) + expandLeading(raw, i + 1, col + w);
  }
  return expandLeading(raw, i, col);
}

// Columns spanned by a whitespace string starting at column startCol
// (tabs advance to the next multiple of 4).
function wsCols(s, startCol) {
  let col = startCol;
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === 9) col += 4 - (col % 4);
    else col++;
  }
  return col - startCol;
}

// Blockquote content: strip '>' plus one optional space/tab, expanding
// the leading whitespace to spaces on the ORIGINAL columns.
function bqContent(raw, info) {
  const C = info.indent; // column of '>'
  let idx = info.contentStart + 1; // index after '>'
  let col = C + 1; // column after '>'
  let prefix = '';
  if (idx < raw.length) {
    const cc = raw.charCodeAt(idx);
    if (cc === 32) { idx++; col++; }
    else if (cc === 9) {
      const w = 4 - (col % 4);
      prefix = ' '.repeat(w - 1); // one column of the tab is the optional space
      idx++; col += w;
    }
  }
  return prefix + expandLeading(raw, idx, col);
}

const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

// Is this line a valid fenced-code opening line? A backtick fence whose
// info string contains a backtick is NOT a fence at all (it is paragraph
// text), so it must not interrupt a paragraph or count as a block start.
function isFenceLine(raw) {
  const fm = FENCE_RE.exec(raw);
  if (!fm) return false;
  if (lineInfo(raw).indent > 3) return false;
  return !(fm[1][0] === '`' && fm[2].includes('`'));
}
const DEF_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:\n[ \t]*)?(\S+)?[ \t]*$/;

function isBlankLine(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Heading content: trim, strip closing #'s preceded by space/tab.
function atxContent(s) {
  // Strip a closing sequence: a run of #s at the end, preceded by a
  // space/tab. Check before trimming so a content of only #s (which
  // follows the opening hashes after a space) is stripped too.
  const m = /[ \t]+#+[ \t]*$/.exec(s);
  const t = m ? s.slice(0, m.index) : s;
  const u = t.replace(/^[ \t]+|[ \t]+$/g, '');
  // A content of only #s is a closing sequence (the space before them
  // was consumed by the ATX match).
  if (/^#+$/.test(u)) return '';
  return u;
}

// Split a table row on unescaped pipes, protecting code-span pipes.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Strip one leading/trailing pipe (with surrounding spaces). The
  // line is trimmed first so a space before the leading pipe (or
  // after the trailing one) does not hide it.
  let s = line.trim();
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  i = 0;
  const m = s.length;
  while (i < m) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < m && s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 96) {
      const e = codeSpanEnd(s, i);
      if (e >= 0) { cur += s.slice(i, e); i = e; continue; }
      cur += '`'; i++; continue;
    }
    if (c === 124) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a table delimiter row. Returns array of alignments ('left',
// 'right', 'center', null) or null when the row is not a delimiter.
function parseTableDelim(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t) || !/-/.test(t)) return null;
    if (t[0] === ':' && t[t.length - 1] === ':') aligns.push('center');
    else if (t[t.length - 1] === ':') aligns.push('right');
    else if (t[0] === ':') aligns.push('left');
    else aligns.push(null);
  }
  if (!line.includes('|') && !line.includes(':')) return null;
  return aligns;
}
// Parse a link reference definition starting at lines[i]. Returns the
// number of lines consumed (0 when not a def). Fills refs (first wins).
function parseDef(lines, i, refs) {
  const raw = lines[i];
  // The definition label is a plain label: escapes or chars that are
  // neither '[' nor ']' (a label containing an unescaped '[' or a ']'
  // is not a definition label). It may span up to 3 lines.
  let m = /^ {0,3}\[((?:\\.|[^[\]])+)\]:[ \t]*(.*)$/.exec(raw);
  let labelLines = 0;
  if (!m) {
    let joined = raw;
    for (let k = 1; k <= 2 && i + k < lines.length; k++) {
      joined += '\n' + lines[i + k];
      const mm = /^ {0,3}\[((?:\\.|[^[\]])+)\]:[ \t]*([^\n]*)/.exec(joined);
      if (mm) { m = mm; labelLines = k; break; }
    }
    if (!m) return 0;
  }
  const label = m[1];
  if (!label.trim()) return 0;
  // Collect the body: the remainder of this line plus following non-blank
  // lines (the destination and/or title may sit on later lines, and a
  // quoted title may span several lines).
  const parts = [m[2]];
  let avail = 1;
  while (avail < 8 && i + labelLines + avail < lines.length && !isBlankLine(lines[i + labelLines + avail])) {
    parts.push(lines[i + labelLines + avail].trim());
    avail++;
  }
  const body = parts.join('\n');
  const isWs = (c) => c === 32 || c === 9 || c === 10;
  // Destination.
  let p = 0;
  while (p < body.length && isWs(body.charCodeAt(p))) p++;
  if (p >= body.length) return 0;
  let dest = null;
  let destWasAngle = false;
  if (body.charCodeAt(p) === 60) { // '<'
    const e = body.indexOf('>', p + 1);
    if (e < 0) return 0;
    const inner = body.slice(p + 1, e);
    if (/[\n<>]/.test(inner)) return 0;
    dest = inner; p = e + 1; destWasAngle = true;
    // After an angle-bracket destination, a title (or anything else)
    // must be separated by whitespace.
    if (p < body.length && !isWs(body.charCodeAt(p))) return 0;
  } else {
    const d = parseDest(body, p);
    if (!d) return 0;
    dest = d.dest; p = d.next;
  }
  // Optional title: skip whitespace (possibly across lines); if the next
  // non-whitespace starts a quoted/paren title, parse it (it may span
  // lines). Otherwise the definition ends here, with no title.
  let title = null;
  let endPos = p;
  let q = p;
  while (q < body.length && isWs(body.charCodeAt(q))) q++;
  if (q < body.length) {
    const c = body.charCodeAt(q);
    if (c === 34 || c === 39 || c === 40) {
      const t = parseTitle(body, q);
      if (!t) return 0;
      title = t.title;
      let r = t.next;
      while (r < body.length && isWs(body.charCodeAt(r))) r++;
      if (r < body.length) {
        // Junk after the title. If it is on a later line than the title,
        // the definition simply ends at the title; if on the same line
        // as the title, the title is rejected — and if the title was on
        // the destination's line, the whole definition is invalid,
        // otherwise it stands without a title.
        if (!body.slice(t.next, r).includes('\n')) {
          if (!body.slice(p, q).includes('\n')) return 0;
          endPos = p;
        } else {
          endPos = t.next;
        }
      } else {
        endPos = r;
      }
    } else {
      // No title. Junk on the same line as the destination invalidates
      // the definition; content on a later line is a separate block.
      if (!body.slice(p, q).includes('\n')) return 0;
      endPos = p;
    }
  } else {
    endPos = q;
  }
  // Lines consumed = the line containing the end of the parsed portion.
  let used = 1 + labelLines;
  for (let k = 0; k < endPos && k < body.length; k++) if (body.charCodeAt(k) === 10) used++;
  const key = normLabel(label);
  if (!refs.has(key)) {
    let href;
    try { href = unescapeDest(dest); } catch (e) { href = dest; }
    refs.set(key, { href, title: title !== null ? unescapeDest(title) : null });
  }
  return used;
}

// HTML block start conditions (types 1-7). Returns the type (1-7) or 0.
function htmlBlockType(raw, indent) {
  if (indent > 3) return 0;
  const s = raw.slice(indent);
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(s)) return 1;
  if (/^<!--/.test(s)) return 2;
  if (/^<\?/.test(s)) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (/^<!\[CDATA\[/.test(s)) return 5;
  if (/^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s>\/]|$)/i.test(s)) return 6;
  // Type 7: a complete open/close tag of a non-K tag alone on its line.
  // The tag must match the inline tag grammar (valid attributes, no
  // attributes on a close tag); declarations, PIs, comments and CDATA are
  // types 2-5, not 7.
  if ((s.charCodeAt(0) === 60 && s.length > 1 && ((s.charCodeAt(1) >= 65 && s.charCodeAt(1) <= 90) || (s.charCodeAt(1) >= 97 && s.charCodeAt(1) <= 122))) ||
      (s.charCodeAt(0) === 60 && s.charCodeAt(1) === 47 && s.length > 2 && ((s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) || (s.charCodeAt(2) >= 97 && s.charCodeAt(2) <= 122)))) {
    const tl = matchTag(s, 0);
    if (tl > 0 && s.slice(tl).trim() === '') {
      const name = tagNameOf(s.slice(0, tl));
      if (!BLOCK_TAGS.has(name) && name !== 'script' && name !== 'pre' && name !== 'style' && name !== 'textarea') return 7;
    }
  }
  return 0;
}

// End condition for an HTML block of the given type (line index in lines).
function htmlBlockEnds(type, raw) {
  if (type === 1) return /<\/(script|pre|style|textarea)>/i.test(raw);
  if (type === 2) return raw.includes('-->');
  if (type === 3) return raw.includes('?>');
  if (type === 4) return raw.includes('>');
  if (type === 5) return raw.includes(']]>');
  return false; // types 6/7 end at a blank line
}

// Lex a range of lines into block tokens. refs is filled with link
// definitions. top is true at document top / in blockquotes.
// Does this line interrupt a paragraph (ATX, HR, fence, blockquote, HTML
// block, or a list marker)? Shared by lexLines and lexList. An ordered
// list interrupts a paragraph only when it starts with 1 — except inside
// a list item, where any ordered marker starts a nested list.
function isInterruptLine(raw, inItem) {
  const info = lineInfo(raw);
  if (info.indent > 3) return false;
  const s = raw.slice(info.contentStart);
  if (ATX_RE.test(raw) || HR_RE.test(raw) || isFenceLine(raw)) return true;
  if (s.startsWith('>')) return true;
  // Only HTML block types 1-6 interrupt a paragraph; type 7 (a lone
  // non-block tag) does not.
  const ht = htmlBlockType(raw, info.indent);
  if (ht >= 1 && ht <= 6) return true;
  const lm = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)(.*)$/.exec(raw);
  if (lm) {
    // An empty list item (no content after the marker) cannot interrupt
    // a paragraph. A list interrupts a paragraph only for bullets, or
    // ordered '1' — or any ordered marker inside a list item.
    if (!lm[3].trim()) return false;
    if (lm[1].length === 1) return true;
    const num = parseInt(lm[1], 10);
    if (num === 1 || inItem) return true;
  }
  return false;
}

// Is this content line paragraph text (a line a lazy continuation may
// extend)? Not blank, not indented code, not a block start.
function isParaLine(line) {
  if (isBlankLine(line)) return false;
  const info = lineInfo(line);
  if (info.indent >= 4) return false;
  const s = line.slice(info.contentStart);
  if (ATX_RE.test(line) || HR_RE.test(line) || isFenceLine(line)) return false;
  if (s.startsWith('>')) return false;
  if (htmlBlockType(line, info.indent)) return false;
  if (/^([*+-]|\d{1,9}[.)])([ \t]+|$)/.test(s)) return false;
  return true;
}

// Is the last line inside an open fence that already holds a content
// line? In a list item, a low-indent line joins the fence only once the
// fence has content: an empty fence is ended by the line (the fence
// stays empty and the line starts a new block outside the item).
function inFenceWithContent(lines, lazy) {
  let closeRe = null, hasContent = false;
  for (let q = 0; q < lines.length; q++) {
    if (lazy && lazy.has(q)) continue;
    const l = lines[q];
    if (closeRe) {
      if (closeRe.test(l)) { closeRe = null; hasContent = false; }
      else hasContent = true;
      continue;
    }
    const fm = FENCE_RE.exec(l);
    if (fm && lineInfo(l).indent <= 3) {
      const ch = fm[1][0];
      if (!(ch === '`' && fm[2].includes('`'))) {
        closeRe = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + fm[1].length + ',}[ \\t]*$');
        hasContent = false;
      }
    }
  }
  return closeRe !== null && hasContent;
}

// Is the last line inside an open fenced code block? A lazy continuation
// line must not be absorbed when it is: the fence ends with its
// container, and the lazy line starts a new block outside it. Lazy
// lines are paragraph text, not fence markers, so they are skipped in
// the scan.
function inFence(lines, lazy) {
  let closeRe = null;
  for (let q = 0; q < lines.length; q++) {
    if (lazy && lazy.has(q)) continue;
    const l = lines[q];
    if (closeRe) {
      if (closeRe.test(l)) closeRe = null;
      continue;
    }
    const fm = FENCE_RE.exec(l);
    if (fm && lineInfo(l).indent <= 3) {
      const ch = fm[1][0];
      if (!(ch === '`' && fm[2].includes('`'))) {
        closeRe = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + fm[1].length + ',}[ \\t]*$');
      }
    }
  }
  return closeRe !== null;
}

// Is this line a table body row? A row is any line that is not
// spaces-only, not indented code, and not the start of another block.
// A tab-only line IS a row (it is not spaces-only, and the tab is not
// followed by another character, so it is not indented code either).
function isTableRowLine(line) {
  if (/^ *$/.test(line)) return false;
  if (/^ {4}/.test(line)) return false;
  const tm = /^ {0,3}\t/.exec(line);
  if (tm && line.length > tm[0].length) return false;
  return !isInterruptLine(line, false);
}
// paragraph text that a lazy continuation may extend? A list item's
// marker is stripped too: a lazy line continues the paragraph inside the
// item (e.g. inside a nested blockquote in the item).
function isLazyTarget(line) {
  let cur = line;
  for (let d = 0; d < 8; d++) {
    const info = lineInfo(cur);
    const s = cur.slice(info.contentStart);
    if (s.startsWith('>')) {
      let rest = s.slice(1);
      if (rest.charCodeAt(0) === 32) rest = rest.slice(1);
      else if (rest.charCodeAt(0) === 9) rest = '   ' + rest.slice(1);
      cur = rest;
      continue;
    }
    const lm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(s);
    if (lm) {
      cur = s.slice(lm[0].length);
      continue;
    }
    break;
  }
  return isParaLine(cur);
}

function lexLines(lines, refs, top, docEndNL, lazy) {
  const tokens = [];
  const n = lines.length;
  let i = 0;
  const isInterrupt = (lr) => isInterruptLine(lr, !top);
  const isLazy = lazy || null;
  // Whether a blank line separated the previous block from the next one.
  // Each token is tagged so a list item can tell whether a blank line
  // sits between two of its own blocks (which loosens only that list).
  let pendingBlank = false;
  const pushTok = (t) => { t.blankBefore = pendingBlank; pendingBlank = false; tokens.push(t); };
  while (i < n) {
    const raw = lines[i];
    if (isBlankLine(raw)) { pendingBlank = true; i++; continue; }
    const info = lineInfo(raw);
    const indent = info.indent;
    const s = raw.slice(info.contentStart);
    // Fenced code.
    let fm = FENCE_RE.exec(raw);
    if (fm && indent <= 3) {
      const fenceCh = fm[1][0];
      const fenceLen = fm[1].length;
      const infoStr = fm[2];
      if (fenceCh === '`' && infoStr.includes('`')) { /* not a fence; fall through to paragraph */ }
      else {
        const lang = unescapeDest(infoStr.trim().split(/[ \t]+/)[0] || '');
        const codeLines = [];
        i++;
        const closeRe = new RegExp('^ {0,3}' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
        while (i < n) {
          if (closeRe.test(lines[i])) { i++; break; }
          let cl = lines[i];
          if (fenceCh === '`' && indent > 0) cl = stripFenceIndent(cl, info.contentStart);
          codeLines.push(cl);
          i++;
        }
        pushTok({ type: 'fence', lang: fenceCh === '`' ? lang : lang, text: codeLines.join('\n') });
        continue;
      }
    }
    // ATX heading.
    let am = ATX_RE.exec(raw);
    if (am && indent <= 3) {
      pushTok({ type: 'heading', depth: am[1].length, text: atxContent(am[2] || '') });
      i++; continue;
    }
    // HR.
    if (HR_RE.test(raw) && indent <= 3) {
      pushTok({ type: 'hr' }); i++; continue;
    }
    // Indented code (never interrupts a paragraph; here we are not in one,
    // and top-level indented code is allowed).
    if (indent >= 4) {
      const codeLines = [];
      while (i < n) {
        const lr = lines[i];
        if (isBlankLine(lr)) {
          // A blank line belongs to the code block only if a later
          // indented line follows. A whitespace-only line keeps its
          // spaces past the 4-column code indent.
          let j = i + 1;
          while (j < n && isBlankLine(lines[j])) j++;
          if (j < n && lineInfo(lines[j]).indent >= 4) {
            while (i < j) { codeLines.push(stripIndent(lines[i], 4)); i++; }
            continue;
          }
          break;
        }
        if (lineInfo(lr).indent < 4) break;
        codeLines.push(stripIndent(lr, 4));
        i++;
      }
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      pushTok({ type: 'code', text: codeLines.join('\n') });
      continue;
    }
    // Blockquote.
    if (s.startsWith('>')) {
      const bqLines = [];
      const bqLazy = new Set();
      while (i < n) {
        const lr = lines[i];
        const li = lineInfo(lr);
        const ls = lr.slice(li.contentStart);
        if (ls.startsWith('>')) {
          bqLines.push(bqContent(lr, li));
          i++;
        } else if (isBlankLine(lr)) {
          // A truly blank line (no '>') ends the blockquote; the next
          // '>' line starts a new one.
          break;
        } else if (bqLines.length && isLazyTarget(bqLines[bqLines.length - 1]) && !isInterrupt(lr) && !inFence(bqLines, bqLazy)) {
          // Lazy continuation line (paragraph text only). A lazy line
          // indented 4+ columns has 4 columns stripped, aligning it
          // with the blockquote's paragraph text. It stays paragraph
          // text when the inner content is lexed (bqLazy), even if the
          // stripped line looks like a list marker.
          // A lazy line that looks like a setext underline, following a
          // paragraph of 2+ lines, is indented 4 spaces so it stays
          // paragraph text instead of forming a setext heading.
          const linfo = lineInfo(lr);
          let lazyLine = linfo.indent >= 4 ? stripIndentExpanded(lr, 4) : lr;
          if (SETEXT_RE.test(lazyLine)) {
            let paraLines = 0;
            for (let q = bqLines.length - 1; q >= 0; q--) {
              if (!isParaLine(bqLines[q])) break;
              paraLines++;
            }
            if (paraLines >= 2) lazyLine = '    ' + lazyLine;
          }
          bqLazy.add(bqLines.length);
          bqLines.push(lazyLine);
          i++;
        } else break;
      }
      // A trailing blank line that is exactly empty (a bare '>') is
      // dropped; a space-only line is paragraph content and is kept
      // (it becomes a trailing space in the paragraph text).
      while (bqLines.length && bqLines[bqLines.length - 1] === '') bqLines.pop();
      pushTok({ type: 'blockquote', tokens: lexLines(bqLines, refs, true, false, bqLazy) });
      continue;
    }
    // HTML block.
    const ht = htmlBlockType(raw, indent);
    if (ht) {
      const htmlLines = [raw];
      i++;
      // A type 1-5 block can end on its very first line (e.g. a one-line
      // <style>...</style> or <!-- ... -->); check that before looping.
      if (!(ht <= 5 && htmlBlockEnds(ht, raw))) {
        while (i < n) {
          const lr = lines[i];
          if (ht <= 5) {
            htmlLines.push(lr);
            if (htmlBlockEnds(ht, lr)) { i++; break; }
            i++;
          } else {
            if (isBlankLine(lr)) break;
            htmlLines.push(lr);
            i++;
          }
        }
      }
      // The block's text keeps a trailing newline only when the next line
      // is non-blank content, or the block runs to EOF and the source
      // ends with a newline. Types 1-5 also keep it when the next line
      // is a whitespace-only (but non-empty) blank line: their end
      // regex consumes only the newline after the block, so the text
      // still ends with one; an empty blank line swallows it. Types
      // 6-7 consume the blank line as well, so they do not keep it.
      const next = i < lines.length ? lines[i] : null;
      const nextIsContent = next !== null && !isBlankLine(next);
      const nextIsWsBlank = next !== null && next.length > 0 && isBlankLine(next);
      pushTok({ type: 'html', text: htmlLines.join('\n') + (nextIsContent || (ht <= 5 && nextIsWsBlank) || (i === lines.length && docEndNL) ? '\n' : '') });
      continue;
    }
    // Link reference definition.
    if (indent <= 3 && /^ {0,3}\[/.test(raw)) {
      const used = parseDef(lines, i, refs);
      if (used > 0) { i += used; continue; }
    }
    // List.
    const lm = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(raw);
    if (lm && indent <= 3) {
      const r = lexList(lines, i, refs, docEndNL);
      pushTok(r.token);
      if (r.trailingBlanks) pendingBlank = true;
      i = r.next;
      continue;
    }
    // Paragraph / text (collect lines; setext / table / def-swallow).
    const paraLines = [raw];
    i++;
    let heading = null, table = null;
    while (i < n) {
      const lr = lines[i];
      // A trailing space-only line (the last line, with no newline
      // after it) is paragraph text, not a blank line: `foo\n ` ends
      // up as `foo\n ` inside the paragraph.
      if (isBlankLine(lr) && !(i === n - 1 && lr.length > 0)) break;
      const sm = SETEXT_RE.exec(lr);
      if (sm) {
        heading = { type: 'heading', depth: sm[1][0] === '=' ? 1 : 2, text: paraLines.join('\n').trim() };
        i++;
        break;
      }
      if (paraLines.length === 1) {
        const aligns = parseTableDelim(lr);
        if (aligns) {
          const header = splitTableRow(paraLines[0]);
          if (header.length === aligns.length) {
            const rows = [];
            i++;
            while (i < n && isTableRowLine(lines[i])) {
              const rr = splitTableRow(lines[i]);
              while (rr.length < header.length) rr.push('');
              rows.push(rr.slice(0, header.length));
              i++;
            }
            table = { type: 'table', header, aligns, rows };
            break;
          }
        }
      }
      if (isInterrupt(lr) && !(isLazy && isLazy.has(i))) break;
      // Inside a list item or blockquote the paragraph is a `text`
      // token, and a continuation line indented 4+ columns is lexed as
      // indented code and merged into the text with its 4-column indent
      // removed (a lazy line keeps its spaces only below 4 columns).
      paraLines.push(!top && lineInfo(lr).indent >= 4 ? stripIndent(lr, 4) : lr);
      i++;
    }
    if (heading) { pushTok(heading); continue; }
    if (table) { pushTok(table); continue; }
    pushTok({ type: top ? 'paragraph' : 'text', text: paraLines.join('\n') });
  }
  return tokens;
}

// Lex a list starting at lines[start]. Returns {token, next}.
function lexList(lines, start, refs, docEndNL) {
  const n = lines.length;
  const first = lines[start];
  const fi = lineInfo(first);
  const mm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(first.slice(fi.contentStart));
  const marker = mm[1];
  const ordered = /\d/.test(marker[0]);
  const bulletChar = ordered ? null : marker;
  const delim = ordered ? marker[marker.length - 1] : null;
  const startNum = ordered ? parseInt(marker, 10) : null;
  const markerEndCol = fi.indent + marker.length;
  // Content indent R.
  let R;
  const afterMarker = first.slice(fi.contentStart + marker.length);
  const spacesAfter = /^([ \t]*)/.exec(afterMarker)[1];
  const spaceCols = wsCols(spacesAfter, markerEndCol);
  if (!afterMarker.trim()) {
    R = markerEndCol + 1;
  } else if (spaceCols > 4) {
    R = markerEndCol + 1;
  } else {
    R = markerEndCol + spaceCols;
  }
  const items = [];
  let i = start;
  let loose = false;
  let trailingBlanks = 0;
  // Does this marker start an item of this same list (same bullet char,
  // or same ordered delimiter)?
  const isSameMarker = (m) => {
    if (!m) return false;
    const mk = m[1];
    if (ordered) return /\d/.test(mk[0]) && mk[mk.length - 1] === delim;
    return mk === bulletChar;
  };
  while (i < n) {
    const lr = lines[i];
    if (isBlankLine(lr)) { i++; continue; }
    const li = lineInfo(lr);
    if (li.indent > 3) break;
    const ls = lr.slice(li.contentStart);
    const im = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(ls);
    if (!im) break;
    const imarker = im[1];
    const iordered = /\d/.test(imarker[0]);
    // New list on type / bullet-char / delimiter change.
    if (iordered !== ordered) break;
    if (!ordered && imarker !== bulletChar) break;
    if (ordered && imarker[imarker.length - 1] !== delim) break;
    // A new item marker starts a new item — unless the line is an HR
    // (e.g. `* * *`), which ends the list instead. Items may sit at
    // different indents (0-3) and still be siblings.
    if (HR_RE.test(lr)) break;
    // Collect this item's lines.
    const itemLines = [];
    const itemLazy = new Set();
    let task = null;
    // First line: content starts at this item's content indent (past its
    // own marker + spaces).
    const iMarkerEndCol = li.indent + imarker.length;
    const iAfter = lr.slice(li.contentStart + imarker.length);
    const iSpaces = /^([ \t]*)/.exec(iAfter)[1];
    const iSpaceCols = wsCols(iSpaces, iMarkerEndCol);
    const iR = !iAfter.trim() ? iMarkerEndCol + 1
      : iSpaceCols > 4 ? iMarkerEndCol + 1
      : iMarkerEndCol + iSpaceCols;
    let firstContent;
    if (!iAfter.trim()) {
      firstContent = '';
    } else {
      firstContent = stripToCol(lr, li.contentStart + imarker.length, iMarkerEndCol, iR);
    }
    // Task checkbox: [ ] / [x] / [X] + space/tab + non-space.
    const tkm = /^\[([ xX])\][ \t]+(\S)/.exec(firstContent);
    if (tkm) {
      task = tkm[1] === ' ' ? false : true;
      firstContent = firstContent.slice(tkm[0].length - 1);
    }
    itemLines.push(firstContent);
    i++;
    while (i < n) {
      const cr = lines[i];
      if (isBlankLine(cr)) {
        // An empty item (no content yet) is closed by a blank line.
        // It still loosens the list when another item of the same
        // list follows after the blank(s).
        if (itemLines.every((l) => isBlankLine(l))) {
          let j = i + 1;
          while (j < n && isBlankLine(lines[j])) j++;
          if (j < n) {
            const ji = lineInfo(lines[j]);
            const js = lines[j].slice(ji.contentStart);
            const jm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(js);
            if (jm && isSameMarker(jm) && ji.indent <= 3) loose = true;
          }
          break;
        }
        // A blank line belongs to the item if a following indented line
        // or a following item marker exists. A same-list marker at any
        // indent 0-3 continues the list (items may sit at different
        // indents and still be siblings).
        let j = i + 1;
        while (j < n && isBlankLine(lines[j])) j++;
        if (j < n) {
          const ji = lineInfo(lines[j]);
          const js = lines[j].slice(ji.contentStart);
          const jm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(js);
          if (ji.indent >= iR || (jm && ji.indent === fi.indent) || (jm && isSameMarker(jm) && ji.indent <= 3)) {
            itemLines.push('');
            i++;
            continue;
          }
        }
        break;
      }
      const ci = lineInfo(cr);
      if (ci.indent >= iR) {
        itemLines.push(stripIndentExpanded(cr, iR));
        i++;
        continue;
      }
      // Lower indent: new item marker, lazy paragraph continuation, or end.
      // A marker only starts a new item at indent 0-3; a marker further
      // indented is a lazy continuation of the item's paragraph text.
      const cs = cr.slice(ci.contentStart);
      const cm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(cs);
      if (cm && ci.indent <= 3) break; // next item (handled above)
      // Lazy paragraph continuation: the item's last line is paragraph
      // text, and the line is not an interrupting block (HR, ATX, ...).
      // A lazy line is NOT dedented: its leading spaces are paragraph
      // text (a line with indent 1 under a `- ` item keeps its space).
      // A line is also absorbed when it is the content of an open fence
      // that already holds a line; an empty open fence is ended by it.
      if (itemLines.length && !isBlankLine(itemLines[itemLines.length - 1]) && !isInterruptLine(cr, true) && (!inFence(itemLines, itemLazy) || inFenceWithContent(itemLines, itemLazy))) {
        itemLazy.add(itemLines.length);
        itemLines.push(cr);
        i++;
        continue;
      }
      break;
    }
    // Trailing blank lines of the item: if the next item follows after a
    // blank line, the list is loose.
    let trailBlank = 0;
    while (itemLines.length > 1 && isBlankLine(itemLines[itemLines.length - 1])) { itemLines.pop(); trailBlank++; }
    if (trailBlank > 0) {
      // Peek: is there another item after the blank(s)?
      let j = i;
      while (j < n && isBlankLine(lines[j])) j++;
      if (j < n) {
        const ji = lineInfo(lines[j]);
        const js = lines[j].slice(ji.contentStart);
        const jm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(js);
        if (jm && isSameMarker(jm) && ji.indent <= 3) loose = true;
      }
    }
    // A blank line between this item's content and the next item
    // loosens the list even when only a link reference definition
    // sits between them (a definition is not a block, so the blank
    // is invisible in the lexed blocks).
    {
      let q = itemLines.length - 1;
      let skippedBlank = false;
      while (q >= 0) {
        const l = itemLines[q];
        if (isBlankLine(l)) { skippedBlank = true; q--; continue; }
        if (/^ {0,3}\[((?:\\.|[^[\]])+)\]:/.test(l)) { q--; continue; }
        break;
      }
      if (skippedBlank && q >= 0) {
        let j = i;
        while (j < n && isBlankLine(lines[j])) j++;
        if (j < n) {
          const ji = lineInfo(lines[j]);
          const js = lines[j].slice(ji.contentStart);
          const jm = /^([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(js);
          if (jm && isSameMarker(jm) && ji.indent <= 3) loose = true;
        }
      }
    }
    const blocks = lexLines(itemLines, refs, false, false, itemLazy);
    // Loose: a blank line between two of this item's own top-level
    // blocks. A blank inside a fence or a nested block does not count
    // (so blanks deep inside only loosen the innermost list).
    for (let q = 1; q < blocks.length; q++) {
      if (blocks[q].blankBefore) { loose = true; break; }
    }
    items.push({ blocks, task });
    // Skip blank lines between items (already counted for looseness).
    // Remember how many were skipped after the last item: the
    // enclosing lexer needs to know a blank separated the list from
    // the next block.
    {
      let c = 0;
      while (i < n && isBlankLine(lines[i])) { i++; c++; }
      trailingBlanks = c;
    }
  }
  const token = { type: 'list', ordered, start: startNum, items, loose };
  return { token, next: i, trailingBlanks };
}

// ---- rendering blocks to HTML ----
function renderBlocks(tokens, refs, linkState) {
  const out = [];
  for (const t of tokens) {
    if (t.type === 'paragraph') {
      out.push('<p>' + renderInline(t.text, refs, false, { raw: false }, linkState) + '</p>\n');
    } else if (t.type === 'text') {
      // Plain text inside a list item: rendered inline (no <p>) by the
      // list renderer; a loose list converts it to a paragraph first.
      out.push(renderInline(t.text, refs, false, { raw: false }, linkState));
    } else if (t.type === 'heading') {
      out.push('<h' + t.depth + '>' + renderInline(t.text, refs, false, { raw: false }, linkState) + '</h' + t.depth + '>\n');
    } else if (t.type === 'hr') {
      out.push('<hr>\n');
    } else if (t.type === 'code') {
      out.push('<pre><code>' + escAll(t.text ? t.text + '\n' : '') + '</code></pre>\n');
    } else if (t.type === 'fence') {
      const langAttr = t.lang ? ' class="language-' + escText(t.lang) + '"' : '';
      // The code ends with a newline unless it is empty or already
      // ends with one (an all-blank fence renders a single newline).
      const ft = t.text ? (t.text.endsWith('\n') ? t.text : t.text + '\n') : '';
      out.push('<pre><code' + langAttr + '>' + escAll(ft) + '</code></pre>\n');
    } else if (t.type === 'blockquote') {
      out.push('<blockquote>\n' + renderBlocks(t.tokens, refs, linkState) + '</blockquote>\n');
    } else if (t.type === 'html') {
      out.push(t.text);
    } else if (t.type === 'table') {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < t.header.length; c++) {
        const a = t.aligns[c];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(t.header[c], refs, false, { raw: false }, linkState) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (t.rows.length) {
        out.push('<tbody>');
        for (const row of t.rows) {
          out.push('<tr>\n');
          for (let c = 0; c < row.length; c++) {
            const a = t.aligns[c];
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(row[c], refs, false, { raw: false }, linkState) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
    } else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const startAttr = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
      out.push('<' + tag + startAttr + '>\n');
      for (const item of t.items) {
        let li = '<li>';
        const cb = (item.task !== null && item.task !== undefined)
          ? (item.task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
          : '';
        if (t.loose) {
          // A loose list's text blocks are paragraphs. The checkbox
          // belongs inside the first paragraph, not before it.
          const bl = item.blocks.map((b) => b.type === 'text'
            ? { type: 'paragraph', text: b.text, blankBefore: b.blankBefore } : b);
          let html = renderBlocks(bl, refs, linkState);
          if (cb) {
            if (html.startsWith('<p>')) html = '<p>' + cb + html.slice(3);
            else li += cb;
          }
          li += html;
        } else {
          li += cb;
          // Tight: the first paragraph is unwrapped; text blocks render
          // inline (no <p>); other blocks render normally.
          const blocks = item.blocks;
          for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            if (b.type === 'paragraph' || b.type === 'text') {
              li += renderInline(b.text, refs, false, { raw: false }, linkState);
            } else {
              li += renderBlocks([b], refs, linkState);
            }
          }
        }
        li += '</li>\n';
        out.push(li);
      }
      out.push('</' + tag + '>\n');
    }
  }
  return out.join('');
}

// ---- entry point ----
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // Drop the trailing empty line produced by a final newline.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const tokens = lexLines(lines, refs, true, src.endsWith('\n'));
  // Document-wide inLink state (see renderInline): a raw `<a href>`
  // tag in inline content suppresses later bare autolinks until `</a>`.
  const linkState = { inLink: false };
  return renderBlocks(tokens, refs, linkState);
}
