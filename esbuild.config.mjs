import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync } from "fs";

const prod = process.argv[2] === "production";

// Everything Obsidian needs ends up in this folder, ready to copy into
// <vault>/.obsidian/plugins/
const outdir = "snapshot-diff";

// copy the static plugin files next to main.js after every (re)build
const copyStatic = {
	name: "copy-static",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(outdir, { recursive: true });
			for (const f of ["manifest.json", "styles.css"]) copyFileSync(f, `${outdir}/${f}`);
		});
	},
};

// Obsidian ships its own CodeMirror and the merge view must use those same
// instances, so every @codemirror package is external except @codemirror/merge,
// which Obsidian doesn't include.
const external = [
	"obsidian",
	"electron",
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
	...builtinModules,
];

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external,
	format: "cjs",
	target: "es2018",
	// compile `await import("child_process")` (desktop-only, see GitHistory) to
	// require(): Obsidian's renderer can require Node built-ins, but a native
	// dynamic import of one isn't something to rely on
	supported: { "dynamic-import": false },
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	minify: prod,
	outfile: `${outdir}/main.js`,
	plugins: [copyStatic],
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
