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
	return absorbShortEqualities(changes, a).map((c) => spaceFirst(c, a, b));
}

// A word added between two others can come out as "canvas " or " canvas": the
// diff picks either. Put the space first, as it is for a word added before a
// period or at the end of a line, so added and removed words all look alike.
function spaceFirst(c: Change, a: string, b: string): Change {
	if (c.fromA < c.toA && c.fromB < c.toB) return c; // replacement: no choice
	const [s, from, to] = c.fromA === c.toA ? [b, c.fromB, c.toB] : [a, c.fromA, c.toA];
	const last = s[to - 1];
	if ((last !== " " && last !== "\t") || s[from - 1] !== last || /\s/.test(s[from])) return c;
	// the character before is the same space, so the window can slide back by one
	return new Change(c.fromA - 1, c.toA - 1, c.fromB - 1, c.toB - 1);
}

// Matching whole words still keeps every word the two versions share, so a
// rewritten sentence comes out as a scatter of changes split by a stray "the",
// "and" or ", ". Like diff-match-patch's semantic cleanup, fold an unchanged run
// into the changes around it when it's no longer than the change on either side.
// A pure insertion or deletion counts half its length: words added around
// unchanged text ("a canvas bag, a brass compass") read fine as they are. A run
// with a line break is always kept, so paragraphs still line up.
function absorbShortEqualities(changes: readonly Change[], a: string): Change[] {
	const weight = (c: Change) => {
		const lenA = c.toA - c.fromA, lenB = c.toB - c.fromB;
		return lenA && lenB ? Math.max(lenA, lenB) : (lenA + lenB) / 2;
	};
	const out: Change[] = [];
	for (let cur of changes) {
		// merging makes the change bigger, so the run before it may now qualify too
		for (let prev = out[out.length - 1]; prev; prev = out[out.length - 1]) {
			const gap = cur.fromA - prev.toA;
			if (gap > weight(prev) || gap > weight(cur) || a.slice(prev.toA, cur.fromA).includes("\n")) break;
			out.pop();
			cur = new Change(prev.fromA, cur.toA, prev.fromB, cur.toB);
		}
		out.push(cur);
	}
	return out;
}
