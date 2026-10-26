import { Change, diff } from "@codemirror/merge";

// Word-level diff for the merge view (passed as `diffConfig.override`).
//
// The stock diff compares characters, so in a rewritten sentence it happily
// matches stray letters, e.g. the "and" inside a newly written "landing", and
// highlights the word around them in pieces. This diffs whole tokens instead:
// every distinct token is encoded as one character, the stock algorithm diffs
// the encoded strings, and the result is mapped back to character offsets.

// words (letters, digits, marks, inner apostrophes), a newline, a run of other
// whitespace, or any single other character; together they cover every character
const TOKEN_RE = /[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*|\n|[^\S\n]+|[^\p{L}\p{M}\p{N}_\s]/gu;

// The stock diff's step limit gives up after a few hundred differences and
// marks everything in between as one changed block; bound it by time instead.
const TIMEOUT = 1000;

export function wordDiff(a: string, b: string): readonly Change[] {
	const codes = new Map<string, number>();
	let next = 0;

	const encode = (text: string) => {
		const starts: number[] = []; // char offset of each token, plus text.length
		let enc = "";
		TOKEN_RE.lastIndex = 0;
		for (let m; (m = TOKEN_RE.exec(text)); ) {
			let code = codes.get(m[0]);
			if (code === undefined) {
				if (next === 0xd800) next = 0xe000; // the diff treats surrogate code units specially
				code = next++;
				codes.set(m[0], code);
			}
			starts.push(m.index);
			enc += String.fromCharCode(code);
		}
		starts.push(text.length);
		return { enc, starts };
	};

	const A = encode(a);
	const B = encode(b);
	// more distinct tokens than one UTF-16 unit can encode: diff characters instead
	if (next > 0xffff) return diff(a, b, { timeout: TIMEOUT });

	const changes = diff(A.enc, B.enc, { timeout: TIMEOUT }).map(
		(c) => new Change(A.starts[c.fromA], A.starts[c.toA], B.starts[c.fromB], B.starts[c.toB])
	);
	const absorbed = absorbShortEqualities(changes, a);
	const out: Change[] = [];
	for (let i = 0; i < absorbed.length; i++) {
		// slide only within the unchanged text around it, behind the previous change as moved
		const min = out.length ? out[out.length - 1].toA : 0;
		const max = i + 1 < absorbed.length ? absorbed[i + 1].fromA : a.length;
		out.push(spaceFirst(absorbed[i], a, b, min, max));
	}
	return out;
}

const BOUNDARIES = "\n\"“”„«»‹›()[]{}";
const SINGLE_QUOTES = "'‘’";
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/** Whether s[from..to) has a line break, quote or bracket (but not an apostrophe inside a word). */
function hasBoundary(s: string, from: number, to: number) {
	for (let i = from; i < to; i++) {
		if (BOUNDARIES.includes(s[i])) return true;
		if (SINGLE_QUOTES.includes(s[i]) && !(WORD_CHAR.test(s[i - 1] ?? "") && WORD_CHAR.test(s[i + 1] ?? ""))) return true;
	}
	return false;
}

// An added or removed word or sentence can often sit in more than one place:
// "canvas " or " canvas", ". Sentence 3" or " Sentence 3.", and the diff picks
// either. Slide it to the nearest place where it starts with its space, so it
// keeps its own punctuation and added and removed text all look alike.
function spaceFirst(c: Change, a: string, b: string, minA: number, maxA: number): Change {
	if (c.fromA < c.toA && c.fromB < c.toB) return c; // replacement: no choice
	const [s, from, to] = c.fromA === c.toA ? [b, c.fromB, c.toB] : [a, c.fromA, c.toA];
	const startsWithSpace = (pos: number) => (s[pos] === " " || s[pos] === "\t") && !/\s/.test(s[pos - 1] ?? "");
	if (startsWithSpace(from)) return c;
	// it can slide by k while the k characters it uncovers match the ones it covers
	let back = true, forward = true;
	for (let k = 1; back || forward; k++) {
		back = back && c.fromA - k >= minA && s[from - k] === s[to - k];
		forward = forward && c.toA + k <= maxA && s[from + k - 1] === s[to + k - 1];
		if (back && startsWithSpace(from - k)) return shift(c, -k);
		if (forward && startsWithSpace(from + k)) return shift(c, k);
	}
	return c;
}

const shift = (c: Change, k: number) => new Change(c.fromA + k, c.toA + k, c.fromB + k, c.toB + k);

// how many changes a side is weighed over, so a long stretch of alternating
// small edits doesn't make the cleanup quadratic
const MAX_SIDE = 20;

// Matching whole words still keeps every word the two versions share, so a
// rewritten sentence comes out as a scatter of changes split by a stray "the",
// "and" or ", ". Like diff-match-patch's semantic cleanup, fold an unchanged run
// into the changes around it when the changes on both sides outweigh it.
//
// A side is weighed outward from the run, not just by the nearest change: the
// changes there count for, the shorter unchanged runs between them count
// against, and a longer run ends the side. Otherwise one small change next to
// a shared word ("walked{ backward} into") keeps it unchanged in the middle of
// a rewritten sentence, and since the diff picks between equally good matches
// using the whole text, an edit anywhere else could decide whether that happens.
//
// A pure insertion or deletion counts half its length: words added around
// unchanged text ("a canvas bag, a brass compass") read fine as they are. A run
// with a line break is always kept, so paragraphs still line up, and so is one
// with a quote or bracket, which marks where a quotation or an aside starts or
// ends: in "Is anyone there?" → "Hello?" only the words inside are changed.
function absorbShortEqualities(changes: readonly Change[], a: string): Change[] {
	const weight = (c: Change) => {
		const lenA = c.toA - c.fromA, lenB = c.toB - c.fromB;
		return lenA && lenB ? Math.max(lenA, lenB) : (lenA + lenB) / 2;
	};
	let cur = changes.slice();
	// Folding a run only makes the changes around other runs bigger, so fold every
	// run that qualifies at once and repeat until none does; the result then
	// doesn't depend on the order the runs are looked at.
	for (;;) {
		// gaps[i] is the unchanged run before cur[i]: its length, or -1 if it's always kept
		const gaps = cur.map((c, i) => (i && !hasBoundary(a, cur[i - 1].toA, c.fromA) ? c.fromA - cur[i - 1].toA : -1));
		const outweighs = (i: number, dir: 1 | -1) => {
			const len = gaps[i];
			let net = 0;
			for (let j = dir > 0 ? i : i - 1, n = 0; j >= 0 && j < cur.length && n < MAX_SIDE; j += dir, n++) {
				net += weight(cur[j]);
				if (net >= len) return true;
				const next = gaps[dir > 0 ? j + 1 : j] ?? -1;
				if (next < 0 || next > len) return false;
				net -= next;
			}
			return false;
		};
		const fold = gaps.map((len, i) => len >= 0 && outweighs(i, -1) && outweighs(i, 1));
		if (!fold.includes(true)) return cur;
		const out: Change[] = [];
		for (let i = 0; i < cur.length; i++) {
			const prev = out[out.length - 1];
			if (fold[i]) out[out.length - 1] = new Change(prev.fromA, cur[i].toA, prev.fromB, cur[i].toB);
			else out.push(cur[i]);
		}
		cur = out;
	}
}
