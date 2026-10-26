import type { EditorView } from "@codemirror/view";

// The parts of CodeMirror's internal DocView this relies on (not part of its API)
interface DocViewInternals {
	children?: { dom: HTMLElement | null; length: number; breakAfter: number }[];
	measureVisibleLineHeights?: (viewport: { from: number; to: number }) => number[];
}

// how far the reported heights may add up from the real ones before they're all measured again
const TOLERANCE = 0.1;

/**
 * Make CodeMirror re-measure only the lines whose DOM changed since its last measure, and reuse
 * the heights it measured before for the rest.
 *
 * The diff draws every line (see SnapshotDiffView.drawAll), and after any change CodeMirror reads
 * the height of every drawn line, one getBoundingClientRect each: on a note with a few thousand
 * lines that was about a fifth of every keystroke. A MutationObserver tells which lines CodeMirror
 * touched (text, highlighting, spacer heights); the rest keep their height unless something
 * outside the document changes it (width, font, theme). To catch that, the reported heights are
 * added up and compared with the real distance from the first line to the last: if they differ,
 * every line is measured again, as CodeMirror would have.
 *
 * Replaces an internal method on this view's DocView. If that method or the line list isn't
 * there, nothing is changed and this returns null; otherwise it returns a function that stops it.
 * Assumes line wrapping is on: CodeMirror's own version also tracks the widest line when it's off.
 */
export function measureChangedLinesOnly(view: EditorView): (() => void) | null {
	const docView = (view as unknown as { docView?: DocViewInternals }).docView;
	const original = docView?.measureVisibleLineHeights;
	if (!docView || typeof original !== "function" || !Array.isArray(docView.children)) return null;
	const content = view.contentDOM;
	let heights = new WeakMap<Element, number>();
	let records: MutationRecord[] = [];
	const observer = new MutationObserver((list) => records.push(...list));
	observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });

	const measure = (viewport: { from: number; to: number }, reuse: boolean): number[] => {
		// the lines (direct children of the content element) that changed since the last measure
		const changed = new Set<Node>();
		for (const record of records.concat(observer.takeRecords())) {
			let node: Node | null = record.target;
			while (node && node.parentNode !== content) node = node.parentNode;
			if (node) changed.add(node);
		}
		records = [];

		const result: number[] = [];
		let first: Element | null = null, last: Element | null = null, sum = 0, reused = false;
		const children = docView.children ?? [];
		for (let pos = 0, i = 0; i < children.length; i++) {
			const child = children[i], end = pos + child.length;
			if (end > viewport.to) break;
			if (pos >= viewport.from) {
				const dom = child.dom;
				if (!dom) return original.call(docView, viewport);
				let height = reuse && !changed.has(dom) ? heights.get(dom) : undefined;
				if (height === undefined) {
					height = dom.getBoundingClientRect().height;
					heights.set(dom, height);
				} else reused = true;
				result.push(height);
				sum += height;
				first ??= dom;
				last = dom;
			}
			pos = end + child.breakAfter;
		}
		if (reused && first && last) {
			const real = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
			if (Math.abs(real - sum) > TOLERANCE) {
				heights = new WeakMap();
				return measure(viewport, false);
			}
		}
		return result;
	};

	docView.measureVisibleLineHeights = (viewport) => measure(viewport, true);
	return () => {
		observer.disconnect();
		docView.measureVisibleLineHeights = original;
	};
}
