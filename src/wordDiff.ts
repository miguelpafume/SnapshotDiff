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

	return diff(A.enc, B.enc, { timeout: TIMEOUT }).map(
		(c) => new Change(A.starts[c.fromA], A.starts[c.toA], B.starts[c.fromB], B.starts[c.toB])
	);
}
