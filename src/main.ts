import {
	App,
	FileSystemAdapter,
	FuzzySuggestModal,
	ItemView,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionControl,
	SuggestModal,
	TAbstractFile,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	normalizePath,
	debounce,
	setIcon,
} from "obsidian";
import { MergeView } from "@codemirror/merge";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { wordDiff } from "./wordDiff";

interface SnapshotDiffSettings {
	snapshotFolder: string;
	collapseUnchanged: boolean;
	showRevertControls: boolean;
	askForName: boolean;
	maxSnapshots: number; // per note; 0 = no limit
}

const DEFAULT_SETTINGS: SnapshotDiffSettings = {
	snapshotFolder: ".snapshots",
	collapseUnchanged: false,
	showRevertControls: true,
	askForName: false,
	maxSnapshots: 5,
};

const VIEW_TYPE = "snapshot-diff-view";

// how many versions of each kind the compare picker lists
const PICKER_LIMIT = 5;

// how far apart a delete and a create can be and still count as one rename made outside Obsidian
const EXTERNAL_RENAME_MS = 5000;

// Snapshots are plain .md files at <snapshotFolder>/<note path without .md>/<note name> <YYYY-MM-DD_HH-mm-ss>[ name].md
// The folder ties snapshots to their note; the note name in the file name is
// only for people browsing the folder. A dot-folder is hidden from Obsidian's
// explorer, search and graph, but it's still on disk (and in git, unless ignored).

interface Snapshot {
	path: string; // adapter path of the snapshot file
	time: number; // ms epoch, parsed from the file name
	label: string; // optional user-given name
}

function pad(n: number) {
	return n.toString().padStart(2, "0");
}

function stamp(d: Date) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// the part of a snapshot file name after the note name: "<stamp>[ name].md"
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?: (.*))?\.md$/;
const STAMPED_RE = /^(?:.*? )?((\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?: .*)?\.md)$/;

/**
 * The "<stamp>[ name].md" part of a snapshot file name, or null if it isn't one.
 * Strips `noteName` first, so a date inside the note name can't be mistaken for
 * the snapshot's; otherwise accepts any prefix, or none (the original
 * timestamp-only format).
 */
function stampPart(fileName: string, noteName: string) {
	const prefix = `${noteName} `;
	const rest = fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
	return STAMP_RE.test(rest) ? rest : (STAMPED_RE.exec(rest)?.[1] ?? null);
}

function noteNameOf(path: string) {
	return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function parentOf(path: string) {
	return path.split("/").slice(0, -1).join("/");
}

function sanitize(name: string) {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 80);
}

function formatWhen(t: number) {
	const d = new Date(t);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return sameDay ? `Today ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

class SnapshotStore {
	constructor(private app: App, private plugin: SnapshotDiffPlugin) {}

	private get root() {
		return normalizePath(this.plugin.settings.snapshotFolder || ".snapshots");
	}

	folderFor(notePath: string) {
		return normalizePath(`${this.root}/${notePath.replace(/\.md$/i, "")}`);
	}

	private async ensureFolder(path: string) {
		const adapter = this.app.vault.adapter;
		const parts = path.split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
		}
	}

	async create(file: TFile, label: string): Promise<Snapshot> {
		const content = await this.app.vault.read(file);
		const folder = this.folderFor(file.path);
		await this.ensureFolder(folder);
		const now = new Date();
		const clean = sanitize(label);
		const base = `${folder}/${file.basename} ${stamp(now)}${clean ? " " + clean : ""}`;
		let path = normalizePath(`${base}.md`);
		// two snapshots in the same second: add a suffix
		let i = 2;
		while (await this.app.vault.adapter.exists(path)) {
			path = normalizePath(`${base} (${i++}).md`);
		}
		await this.app.vault.adapter.write(path, content);
		return { path, time: now.getTime(), label: clean };
	}

	async list(file: TFile): Promise<Snapshot[]> {
		const folder = this.folderFor(file.path);
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(folder))) return [];
		const { files } = await adapter.list(folder);
		const out: Snapshot[] = [];
		for (const p of files) {
			const m = STAMP_RE.exec(stampPart(p.split("/").pop() ?? "", file.basename) ?? "");
			if (!m) continue;
			const [, y, mo, d, h, mi, s, label] = m;
			out.push({
				path: p,
				time: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(),
				label: label ?? "",
			});
		}
		return out.sort((a, b) => b.time - a.time); // newest first
	}

	read(s: Snapshot) {
		return this.app.vault.adapter.read(s.path);
	}

	/** Move a snapshot to the system trash, or the vault's .trash folder when there's none. */
	async trash(s: Snapshot) {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.trashSystem(s.path))) await adapter.trashLocal(s.path);
	}

	/**
	 * Permanently delete the oldest snapshots so at most `max` remain. Returns how
	 * many were deleted. Not trashed: the user asked for the limit, and trashing
	 * every pruned snapshot would just fill the trash.
	 */
	async prune(file: TFile, max: number) {
		if (max <= 0) return 0;
		const excess = (await this.list(file)).slice(max);
		for (const s of excess) await this.app.vault.adapter.remove(s.path);
		return excess.length;
	}

	/**
	 * Keep snapshots attached to a note when it's renamed or moved: move its
	 * files to the new folder, renamed to the new note name. Returns the old → new
	 * path of every file moved, so open diff tabs can follow.
	 */
	async onRename(file: TAbstractFile, oldPath: string) {
		const moved = new Map<string, string>();
		if (!(file instanceof TFile) || file.extension !== "md") return moved;
		const adapter = this.app.vault.adapter;
		const from = this.folderFor(oldPath);
		const to = this.folderFor(file.path);
		if (from === to || !(await adapter.exists(from))) return moved;
		// Move the files one by one, never the folder: it can also hold the snapshot
		// folders of the notes in a folder of the same name ("Projects.md" next to
		// "Projects/"), and the target folder can already exist for the same reason.
		const { files } = await adapter.list(from);
		if (files.length) await this.ensureFolder(to);
		const oldName = noteNameOf(oldPath);
		const renamed = file.basename !== oldName; // a plain move keeps the file names
		for (const p of files) {
			const name = p.split("/").pop() ?? "";
			const rest = renamed ? stampPart(name, oldName) : null;
			const target = normalizePath(`${to}/${rest ? `${file.basename} ${rest}` : name}`);
			if (await adapter.exists(target)) continue; // don't clobber; it stays where it was
			await adapter.rename(p, target);
			moved.set(p, target);
		}
		// remove the old folder only if nothing is left in it. recursive is true even
		// though it's empty: with false, Obsidian's desktop adapter runs fs.rm without
		// it, which fails on any folder (EISDIR)
		const left = await adapter.list(from);
		if (!left.files.length && !left.folders.length) await adapter.rmdir(from, true);
		return moved;
	}
}

interface Commit {
	hash: string;
	path: string; // the note's path at that commit, relative to the repo root
	time: number; // ms epoch, author date
	subject: string;
}

// Desktop only: runs the system `git` from the vault folder, so it works whether
// the vault is the repo root or a subfolder of it. Anything that goes wrong
// (mobile, no git, not a repo, untracked note) yields no commits.
class GitHistory {
	constructor(private app: App) {}

	private cwd(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	private async run(args: string[]): Promise<string> {
		// Node modules don't exist on mobile: bail out first, then import lazily
		if (!Platform.isDesktop) throw new Error("Git history is only available on desktop");
		const cwd = this.cwd();
		if (!cwd) throw new Error("Git history needs a vault on the local file system");
		const { execFile } = await import("child_process");
		const { promisify } = await import("util");
		const { stdout } = await promisify(execFile)(
			"git",
			// quotepath=off keeps non-ASCII paths readable in --name-only output
			["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
			{ cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }
		);
		return stdout;
	}

	/** Latest commits that changed the note, newest first, following renames. */
	async log(file: TFile, limit: number): Promise<Commit[]> {
		let out: string;
		try {
			out = await this.run([
				"log",
				`-n${limit}`,
				"--follow",
				"--no-merges",
				"--format=%x1e%H%x1f%at%x1f%s",
				"--name-only",
				"--",
				file.path,
			]);
		} catch {
			return [];
		}
		const commits: Commit[] = [];
		for (const chunk of out.split("\x1e")) {
			const lines = chunk.split("\n").filter((l) => l.trim());
			if (lines.length < 2) continue;
			const [hash, at, subject] = lines[0].split("\x1f");
			const path = lines[lines.length - 1];
			if (path.startsWith('"')) continue; // still quoted: exotic characters, can't address it
			commits.push({ hash, path, time: +at * 1000, subject: subject ?? "" });
		}
		return commits;
	}

	show(c: Commit) {
		return this.run(["show", `${c.hash}:${c.path}`]);
	}
}

// Obsidian's core File recovery plugin saves a version of each note every few
// minutes (kept 7 days by default) in IndexedDB. There's no public API for it,
// so this reads the plugin's "backups" store the same way Obsidian's own code
// does. Plugin disabled, internals changed, or any other failure: no versions.

interface Backup {
	path: string;
	ts: number; // ms epoch
	data: string;
}

// the slice of Obsidian's private API used here; everything optional, since it can change
interface FileRecoveryInternals {
	internalPlugins?: {
		getEnabledPluginById?(id: string): {
			db?: {
				transaction(store: "backups", mode: "readonly"): {
					store: { index(name: "path"): { getAll(path: string): Promise<Backup[]> } };
				};
			} | null;
		} | null;
	};
}

class FileRecovery {
	constructor(private app: App) {}

	/** Versions saved for a vault path, newest first. */
	async list(path: string): Promise<Backup[]> {
		try {
			const internals = this.app as unknown as FileRecoveryInternals;
			const db = internals.internalPlugins?.getEnabledPluginById?.("file-recovery")?.db;
			if (!db) return [];
			const all = await db.transaction("backups", "readonly").store.index("path").getAll(path);
			return all.sort((a, b) => b.ts - a.ts);
		} catch (e) {
			console.error("Snapshot Diff: couldn't read file recovery", e);
			return [];
		}
	}
}

// what the left pane of the diff compares against

type Version =
	| { kind: "snapshot"; snapshot: Snapshot }
	| { kind: "recovery"; backup: Backup }
	| { kind: "git"; commit: Commit };

function versionTitle(v: Version) {
	switch (v.kind) {
		case "snapshot":
			return v.snapshot.label ? `${formatWhen(v.snapshot.time)} — ${v.snapshot.label}` : formatWhen(v.snapshot.time);
		case "recovery":
			return formatWhen(v.backup.ts);
		case "git":
			return `${formatWhen(v.commit.time)} — ${v.commit.subject}`;
	}
}

/** Short label for the diff header tag. */
function versionTag(v: Version) {
	return { snapshot: "Snapshot", recovery: "Recovery", git: "Commit" }[v.kind];
}

/** Second line in the picker. */
function versionNote(v: Version) {
	if (v.kind === "git") return `Git commit ${v.commit.hash.slice(0, 7)}`;
	return v.kind === "recovery" ? "File recovery" : "Snapshot";
}

const VERSION_ICONS = { snapshot: "camera", recovery: "history", git: "git-commit-horizontal" };

/** Kept in the diff view's state to find the version again after a restart. */
interface VersionRef {
	snapshot?: string; // snapshot path
	recovery?: { path: string; ts: number }; // backup key; the text is re-read, not stored
	commit?: Commit;
}

function versionRef(v: Version): VersionRef {
	switch (v.kind) {
		case "snapshot":
			return { snapshot: v.snapshot.path };
		case "recovery":
			return { recovery: { path: v.backup.path, ts: v.backup.ts } };
		case "git":
			return { commit: v.commit };
	}
}

class NameModal extends Modal {
	private value = "";
	constructor(app: App, private onSubmit: (name: string) => void) {
		super(app);
	}
	onOpen() {
		this.setTitle("Snapshot name (optional)");
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "snapshot-diff-name-input",
			attr: { placeholder: "Before rewriting the ending" },
		});
		input.addEventListener("input", () => (this.value = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.close();
				this.onSubmit(this.value);
			}
		});
		window.setTimeout(() => input.focus(), 0);
	}
	onClose() {
		this.contentEl.empty();
	}
}

class SnapshotPicker extends FuzzySuggestModal<Snapshot> {
	constructor(
		app: App,
		private snapshots: Snapshot[],
		placeholder: string,
		private onPick: (s: Snapshot) => void
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems() {
		return this.snapshots;
	}
	getItemText(snapshot: Snapshot) {
		return versionTitle({ kind: "snapshot", snapshot });
	}
	onChooseItem(s: Snapshot) {
		this.onPick(s);
	}
}

type PickerItem = Version | { kind: "all"; label: string; versions: Version[] };

/**
 * Versions grouped by source, each group newest first. A group that didn't fit
 * ends with a "Show all…" row that reopens the picker with the whole group.
 */
class VersionPicker extends SuggestModal<PickerItem> {
	constructor(app: App, private items: PickerItem[], private onPick: (v: Version) => void) {
		super(app);
		this.setPlaceholder("Compare with which version?");
	}
	getSuggestions(query: string) {
		const q = query.toLowerCase();
		// the "show all" row stays visible whatever the query
		return this.items.filter((v) => v.kind === "all" || versionTitle(v).toLowerCase().includes(q));
	}
	renderSuggestion(v: PickerItem, el: HTMLElement) {
		el.addClass("snapshot-diff-suggestion");
		setIcon(el.createDiv("snapshot-diff-suggestion-icon"), v.kind === "all" ? "list" : VERSION_ICONS[v.kind]);
		const body = el.createDiv();
		body.createDiv({ text: v.kind === "all" ? v.label : versionTitle(v) });
		body.createDiv({
			cls: "snapshot-diff-suggestion-note",
			text: v.kind === "all" ? `${v.versions.length} versions` : versionNote(v),
		});
	}
	onChooseSuggestion(v: PickerItem) {
		if (v.kind === "all") new VersionPicker(this.app, v.versions, this.onPick).open();
		else this.onPick(v);
	}
}

/** Obsidian's "Auto pair brackets" editor setting. Private API, so on (Obsidian's default) if unreadable. */
function autoPairBrackets(app: App) {
	const vault = app.vault as unknown as { getConfig?(key: string): unknown };
	return vault.getConfig?.("autoPairBrackets") !== false;
}

interface DiffViewState extends VersionRef {
	file?: string;
}

class SnapshotDiffView extends ItemView {
	private file: TFile | null = null;
	private version: Version | null = null;
	private merge: MergeView | null = null;
	private headerEl!: HTMLElement;
	private hostEl!: HTMLElement;
	private writing = false; // true while we're saving our own edits
	private saving: Promise<void> | null = null; // the save in progress, for flush()
	private lastWritten = "";

	constructor(leaf: WorkspaceLeaf, private plugin: SnapshotDiffPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return this.file ? `Diff: ${this.file.basename}` : "Snapshot diff";
	}
	getIcon() {
		return "git-compare";
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("snapshot-diff-container");
		this.headerEl = this.contentEl.createDiv("snapshot-diff-header");
		this.hostEl = this.contentEl.createDiv("snapshot-diff-host");

		// live note changed elsewhere (another tab, sync, git checkout...)
		this.registerEvent(
			this.app.vault.on("modify", async (f) => {
				if (!this.file || f.path !== this.file.path || !this.merge) return;
				const disk = await this.app.vault.read(this.file);
				if (this.writing || disk === this.lastWritten) return;
				const b = this.merge.b;
				if (disk === b.state.doc.toString()) return;
				this.lastWritten = disk; // so the update listener doesn't write it back
				// replace only the differing middle, so undo history outside it stays usable,
				// and keep it out of history: undoing it would write the old text back over the outside edit
				const cur = b.state.doc.toString();
				let from = 0;
				while (from < cur.length && from < disk.length && cur[from] === disk[from]) from++;
				let end = 0;
				while (end < cur.length - from && end < disk.length - from && cur[cur.length - 1 - end] === disk[disk.length - 1 - end]) end++;
				b.dispatch({
					changes: { from, to: cur.length - end, insert: disk.slice(from, disk.length - end) },
					annotations: Transaction.addToHistory.of(false),
				});
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f) => {
				if (f === this.file) this.renderHeader();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (f === this.file) this.leaf.detach();
			})
		);
	}

	async onClose() {
		await this.flush();
		this.merge?.destroy();
		this.merge = null;
	}

	getState(): Record<string, unknown> {
		return { file: this.file?.path, ...(this.version ? versionRef(this.version) : {}) };
	}

	async setState(state: DiffViewState, result: ViewStateResult) {
		await super.setState(state, result);
		if (!state.file) return;
		const f = this.app.vault.getAbstractFileByPath(state.file);
		if (!(f instanceof TFile)) return;
		if (state.commit) {
			await this.loadDiff(f, { kind: "git", commit: state.commit });
		} else if (state.recovery) {
			const { path, ts } = state.recovery;
			const backup = (await this.plugin.recovery.list(path)).find((b) => b.ts === ts);
			if (backup) await this.loadDiff(f, { kind: "recovery", backup });
			else new Notice("That file recovery version is gone");
		} else if (state.snapshot) {
			const snapshot = (await this.plugin.store.list(f)).find((s) => s.path === state.snapshot);
			if (snapshot) await this.loadDiff(f, { kind: "snapshot", snapshot });
			else new Notice("Snapshot not found");
		}
	}

	private async readVersion(v: Version): Promise<string> {
		switch (v.kind) {
			case "snapshot":
				return this.plugin.store.read(v.snapshot);
			case "recovery":
				return v.backup.data;
			case "git":
				return this.plugin.git.show(v.commit);
		}
	}

	async loadDiff(file: TFile, version: Version) {
		await this.flush();
		let oldText: string, curText: string;
		try {
			[oldText, curText] = await Promise.all([this.readVersion(version), this.app.vault.read(file)]);
		} catch (e) {
			console.error(e);
			new Notice(version.kind === "git" ? "Couldn't read that commit from git — see console" : "Couldn't read snapshot — see console");
			return;
		}
		this.file = file;
		this.version = version;
		this.lastWritten = curText;
		this.renderHeader();
		this.build(oldText, curText);
		// refresh the tab title (private API, hence optional)
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	/** Follow snapshot files that moved along with their note (old path → new path). */
	snapshotsMoved(moved: Map<string, string>) {
		const v = this.version;
		if (v?.kind !== "snapshot") return;
		const path = moved.get(v.snapshot.path);
		if (path) this.version = { kind: "snapshot", snapshot: { ...v.snapshot, path } };
	}

	/** Rebuild with current settings (called when settings change). */
	async rebuild() {
		if (this.file && this.version) await this.loadDiff(this.file, this.version);
	}

	private save = debounce(
		async () => {
			if (!this.file || !this.merge) return;
			const text = this.merge.b.state.doc.toString();
			if (text === this.lastWritten) return;
			this.writing = true;
			this.lastWritten = text;
			// process() is atomic, unlike modify()
			const saving = this.app.vault.process(this.file, () => text).then(() => {});
			this.saving = saving;
			try {
				await saving;
			} finally {
				this.writing = false;
				if (this.saving === saving) this.saving = null;
			}
		},
		600,
		true
	);

	/** The note this tab shows, if any. */
	get note() {
		return this.file;
	}

	/** Write out any edit still waiting to be saved, and wait until it's on disk. */
	async flush() {
		await this.save.run(); // a pending debounced save, run now
		await this.saving; // one already running
	}

	private build(oldText: string, curText: string) {
		this.merge?.destroy();
		this.hostEl.empty();
		const s = this.plugin.settings;

		const common = [
			// numbers mark real lines; the unnumbered, hatched gaps are alignment filler
			lineNumbers(),
			EditorView.lineWrapping,
			EditorView.theme({ "&": { height: "auto" } }),
		];

		this.merge = new MergeView({
			parent: this.hostEl,
			a: {
				doc: oldText,
				extensions: [
					...common,
					// readOnly blocks edits but, unlike editable.of(false), keeps the
					// pane focusable so text can be selected and copied
					EditorState.readOnly.of(true),
				],
			},
			b: {
				doc: curText,
				extensions: [
					...common,
					// without it Ctrl+Z falls through to the browser's own contenteditable undo,
					// which CodeMirror doesn't track
					history(),
					keymap.of(historyKeymap),
					// like Obsidian's editor: a bracket or quote typed over a selection
					// wraps it, and typing one inserts its pair
					...(autoPairBrackets(this.app) ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
					// save() skips text equal to lastWritten, so changes pulled in from disk aren't written back
					EditorView.updateListener.of((u) => {
						if (u.docChanged) this.save();
					}),
				],
			},
			diffConfig: { override: wordDiff },
			highlightChanges: true,
			gutter: true,
			revertControls: s.showRevertControls ? "a-to-b" : undefined,
			collapseUnchanged: s.collapseUnchanged ? { margin: 3, minSize: 6 } : undefined,
		});
	}

	private renderHeader() {
		this.headerEl.empty();
		const file = this.file;
		if (!file || !this.version) return;
		const left = this.headerEl.createDiv("snapshot-diff-side");
		left.createSpan({ cls: "snapshot-diff-tag old", text: versionTag(this.version) });
		left.createSpan({ text: versionTitle(this.version) });
		const switchBtn = left.createEl("button", { text: "Change…", cls: "snapshot-diff-btn" });
		switchBtn.onclick = () => void this.plugin.pickAndCompare(file, this.leaf);

		const right = this.headerEl.createDiv("snapshot-diff-side");
		right.createSpan({ cls: "snapshot-diff-tag new", text: "Current" });
		right.createSpan({ text: file.path });
		const openBtn = right.createEl("button", { text: "Open note", cls: "snapshot-diff-btn" });
		openBtn.onclick = () => void this.app.workspace.getLeaf("tab").openFile(file);
	}
}

export default class SnapshotDiffPlugin extends Plugin {
	settings!: SnapshotDiffSettings;
	store!: SnapshotStore;
	git!: GitHistory;
	recovery!: FileRecovery;
	// notes deleted or created moments ago, waiting for the other half of an outside rename
	private recentNotes: { kind: "delete" | "create"; file: TFile; at: number }[] = [];

	async onload() {
		await this.loadSettings();
		this.store = new SnapshotStore(this.app, this);
		this.git = new GitHistory(this.app);
		this.recovery = new FileRecovery(this.app);

		this.registerView(VIEW_TYPE, (leaf) => new SnapshotDiffView(leaf, this));

		this.addRibbonIcon("camera", "Take snapshot of current note", () => {
			const f = this.activeNote();
			if (f) void this.takeSnapshot(f, this.settings.askForName);
		});
		this.addRibbonIcon("git-compare", "Compare with previous version", () => {
			const f = this.activeNote();
			if (f) void this.pickAndCompare(f);
		});

		this.addNoteCommand("take-snapshot", "Take snapshot", (f) => this.takeSnapshot(f, this.settings.askForName));
		this.addNoteCommand("take-named-snapshot", "Take named snapshot", (f) => this.takeSnapshot(f, true));
		// the id predates the rename; kept so existing hotkeys keep working
		this.addNoteCommand("compare-with-snapshot", "Compare with previous version…", (f) => this.pickAndCompare(f));
		this.addNoteCommand("compare-with-latest", "Compare with latest snapshot", (f) => this.compareLatest(f));
		this.addNoteCommand("delete-snapshot", "Delete a snapshot…", (f) => this.pickAndDelete(f));

		// right-click menu on notes
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((i) =>
					i
						.setTitle("Take snapshot")
						.setIcon("camera")
						.onClick(() => void this.takeSnapshot(file, this.settings.askForName))
				);
				menu.addItem((i) =>
					i
						.setTitle("Compare with previous version…")
						.setIcon("git-compare")
						.onClick(() => void this.pickAndCompare(file))
				);
			})
		);

		this.registerEvent(this.app.vault.on("rename", (f, old) => void this.onNoteRename(f, old)));
		// after layout ready: Obsidian fires "create" for every file while it loads the vault
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("delete", (f) => this.onNoteDeletedOrCreated("delete", f)));
			this.registerEvent(this.app.vault.on("create", (f) => this.onNoteDeletedOrCreated("create", f)));
		});

		this.addSettingTab(new SnapshotDiffSettingTab(this.app, this));
	}

	/** A command that runs on the active note, and is only available when there is one. */
	private addNoteCommand(id: string, name: string, run: (file: TFile) => Promise<void>) {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const f = this.activeNote(checking);
				if (checking) return !!f;
				if (f) void run(f);
			},
		});
	}

	/** Move a renamed note's snapshots along, and point open diff tabs at the new paths. */
	private async onNoteRename(file: TAbstractFile, oldPath: string) {
		try {
			const moved = await this.store.onRename(file, oldPath);
			if (!moved.size) return;
			for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				(l.view as SnapshotDiffView).snapshotsMoved(moved);
			}
			this.app.workspace.requestSaveLayout();
		} catch (e) {
			console.error("Snapshot Diff: couldn't move snapshots after a rename", e);
			new Notice("Couldn't move this note's snapshots — see console");
		}
	}

	/**
	 * Obsidian reports a rename made outside the app (a terminal, a script, an AI
	 * agent) as a delete and a create. Pair a note that vanished with one that
	 * appeared moments later in the same folder or under the same name, and treat
	 * the pair as a rename. When several notes qualify, only an identical size and
	 * modified time (which a plain rename keeps) decides; otherwise nothing moves.
	 */
	private onNoteDeletedOrCreated(kind: "delete" | "create", f: TAbstractFile) {
		if (!(f instanceof TFile) || f.extension !== "md") return;
		const now = Date.now();
		this.recentNotes = this.recentNotes.filter((e) => now - e.at < EXTERNAL_RENAME_MS);
		const candidates = this.recentNotes.filter(
			(e) => e.kind !== kind && (parentOf(e.file.path) === parentOf(f.path) || e.file.name === f.name)
		);
		const identical = candidates.filter(
			(e) => e.file.stat.size === f.stat.size && e.file.stat.mtime === f.stat.mtime
		);
		const match = identical.length === 1 ? identical[0] : candidates.length === 1 ? candidates[0] : null;
		if (!match) {
			this.recentNotes.push({ kind, file: f, at: now });
			return;
		}
		this.recentNotes.remove(match);
		if (kind === "create") void this.onNoteRename(f, match.file.path);
		else void this.onNoteRename(match.file, f.path);
	}

	/** The note the user is working on, including when the diff view is focused. */
	activeNote(silent = false): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(SnapshotDiffView);
		const fromDiff = view ? (view.getState().file as string | undefined) : undefined;
		const f = fromDiff ? this.app.vault.getAbstractFileByPath(fromDiff) : this.app.workspace.getActiveFile();
		if (f instanceof TFile && f.extension === "md") return f;
		if (!silent) new Notice("Open a Markdown note first");
		return null;
	}

	/**
	 * Write out edits to `file` that open tabs haven't saved yet: Obsidian's editor
	 * saves about 2 s after the last keystroke, a diff tab 600 ms after.
	 */
	private async saveOpenEdits(file: TFile) {
		const saves: Promise<void>[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file === file) saves.push(view.save());
			else if (view instanceof SnapshotDiffView && view.note === file) saves.push(view.flush());
		});
		await Promise.all(saves);
	}

	async takeSnapshot(file: TFile, askName: boolean) {
		const save = async (name: string) => {
			try {
				await this.saveOpenEdits(file);
				const s = await this.store.create(file, name);
				const pruned = await this.store.prune(file, this.settings.maxSnapshots);
				new Notice(
					`Snapshot saved${s.label ? `: ${s.label}` : ""} (${formatWhen(s.time)})` +
						(pruned ? ` — removed ${pruned} old snapshot${pruned > 1 ? "s" : ""}` : "")
				);
			} catch (e) {
				console.error(e);
				new Notice("Couldn't save snapshot — see console");
			}
		};
		if (askName) new NameModal(this.app, (name) => void save(name)).open();
		else await save("");
	}

	async pickAndCompare(file: TFile, leaf?: WorkspaceLeaf) {
		const [snaps, backups, commits, current] = await Promise.all([
			this.store.list(file),
			this.recovery.list(file.path),
			this.git.log(file, PICKER_LIMIT),
			this.app.vault.read(file),
		]);
		const items: PickerItem[] = [];
		const group = (versions: Version[], showAll: string) => {
			items.push(...versions.slice(0, PICKER_LIMIT));
			if (versions.length > PICKER_LIMIT) items.push({ kind: "all", label: showAll, versions });
		};
		group(
			snaps.map((snapshot): Version => ({ kind: "snapshot", snapshot })),
			"Show all snapshots…"
		);
		group(
			// the newest recovery version is often identical to the note: nothing to compare
			backups.filter((b) => b.data !== current).map((backup): Version => ({ kind: "recovery", backup })),
			"Show all file recovery versions…"
		);
		items.push(...commits.map((commit): Version => ({ kind: "git", commit })));
		if (!items.length) {
			new Notice("No snapshots or earlier versions of this note yet — take a snapshot first");
			return;
		}
		new VersionPicker(this.app, items, (v) => void this.openDiff(file, v, leaf)).open();
	}

	async compareLatest(file: TFile) {
		const snaps = await this.store.list(file);
		if (!snaps.length) {
			new Notice("No snapshots for this note yet — take one first");
			return;
		}
		await this.openDiff(file, { kind: "snapshot", snapshot: snaps[0] });
	}

	async pickAndDelete(file: TFile) {
		const snaps = await this.store.list(file);
		if (!snaps.length) {
			new Notice("No snapshots for this note");
			return;
		}
		new SnapshotPicker(this.app, snaps, "Delete which snapshot?", (s) => {
			this.store.trash(s).then(
				() => new Notice("Snapshot moved to trash"),
				(e) => {
					console.error(e);
					new Notice("Couldn't delete snapshot — see console");
				}
			);
		}).open();
	}

	async openDiff(file: TFile, version: Version, leaf?: WorkspaceLeaf) {
		// reuse a diff tab already showing this note, otherwise open a new tab
		leaf ??=
			this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view.getState().file === file.path) ??
			this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE,
			active: true,
			state: { file: file.path, ...versionRef(version) },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<SnapshotDiffSettings> | null);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Redraw open diff tabs, after a setting that changes how the merge view is built. */
	async rebuildViews() {
		for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			await (l.view as SnapshotDiffView).rebuild();
		}
	}
}

type SettingKey = keyof SnapshotDiffSettings;

const VIEW_SETTINGS = new Set<SettingKey>(["collapseUnchanged", "showRevertControls"]);

class SnapshotDiffSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SnapshotDiffPlugin) {
		super(app, plugin);
	}

	/** Obsidian 1.13+ renders the tab from these, which also makes them searchable. */
	getSettingDefinitions(): SettingDefinitionControl<SettingKey>[] {
		return [
			{
				name: "Snapshot folder",
				desc: "Where snapshots are stored, relative to the vault root. A folder starting with a dot is hidden from Obsidian's explorer and search. Changing it doesn't move existing snapshots. If your vault is a git repository, add this folder to your .gitignore.",
				control: { type: "text", key: "snapshotFolder", placeholder: DEFAULT_SETTINGS.snapshotFolder },
			},
			{
				name: "Ask for a name on every snapshot",
				desc: "Off: taking a snapshot saves it instantly with just a timestamp. Taking a named snapshot always asks.",
				control: { type: "toggle", key: "askForName" },
			},
			{
				name: "Maximum snapshots per note",
				desc: "When a new snapshot goes over this limit, the oldest snapshots of that note are deleted. Set to 0 for no limit. Every snapshot is a full copy of its note, so high limits aren't recommended, especially in large vaults. Lowering the limit doesn't delete anything until the next snapshot of each note.",
				control: {
					type: "number",
					key: "maxSnapshots",
					min: 0,
					step: 1,
					placeholder: String(DEFAULT_SETTINGS.maxSnapshots),
					validate: (n) => (Number.isInteger(n) && n >= 0 ? undefined : "Enter a whole number, 0 or more."),
				},
			},
			{
				name: "Collapse unchanged sections",
				desc: "Off: always show the whole file on both sides.",
				control: { type: "toggle", key: "collapseUnchanged" },
			},
			{
				name: "Show restore arrows",
				desc: "Show a button between the panes to copy a changed block from the previous version back into the current note.",
				control: { type: "toggle", key: "showRevertControls" },
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	async setControlValue(key: string, value: unknown) {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		settings[key] = key === "snapshotFolder" ? String(value).trim() || DEFAULT_SETTINGS.snapshotFolder : value;
		await this.plugin.saveSettings();
		if (VIEW_SETTINGS.has(key as SettingKey)) await this.plugin.rebuildViews();
	}

	/** Fallback for Obsidian before 1.13, which ignores getSettingDefinitions(): renders the same definitions. */
	display() {
		const { containerEl } = this;
		containerEl.empty();
		for (const { name, desc, control } of this.getSettingDefinitions()) {
			const setting = new Setting(containerEl).setName(name);
			if (desc) setting.setDesc(desc);
			const value = this.getControlValue(control.key);
			const save = (v: unknown) => void this.setControlValue(control.key, v);
			if (control.type === "toggle") {
				setting.addToggle((t) => t.setValue(value === true).onChange(save));
			} else if (control.type === "number") {
				setting.addText((t) => {
					t.inputEl.type = "number";
					t.setPlaceholder(control.placeholder ?? "")
						.setValue(String(value))
						.onChange((v) => {
							const n = Number(v);
							if (v.trim() && typeof control.validate?.(n) !== "string") save(n);
						});
				});
			} else if (control.type === "text") {
				setting.addText((t) =>
					t
						.setPlaceholder(control.placeholder ?? "")
						.setValue(String(value))
						.onChange(save)
				);
			}
		}
	}
}
