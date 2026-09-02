import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Vite serves and bundles the page. It is not a build step for the game:
// `sim/**`, `render/**` and `ui/**` are all plain ES modules that a browser
// runs as-is, which is why `node test/run.js` needs no `npm install` and never
// will. Vite is here for the dev server, the asset copy and the production
// bundle, and for nothing else.
//
// The predecessor's Solid + TypeScript toolchain is gone: it was declared in
// `package.json` and there was never a `.tsx` file to compile. See the report
// for the reasoning, but the short version is that a TypeScript UI reading a
// 4,200-line *untyped* sim types nothing — it would need hand-written
// declarations mirroring `sim/state.js`, and `CLAUDE.md` is explicit that a
// rule written in two places drifts.

/**
 * Copy the runtime asset folders into the build.
 *
 * The sprite sheets are fetched by URL at runtime, never imported, so a
 * bundler has no idea they exist — the first production build produced a 2 kB
 * index.html and not one pixel of art. A missing sheet is also the quietest
 * possible failure, because the loader is built to fall back to coloured
 * rectangles: the game would have looked "fine" and drawn none of its art.
 *
 * Written inline rather than pulling in vite-plugin-static-copy: this repo
 * gets to keep counting its dependencies on one hand.
 */
function copyRuntimeAssets(dirs) {
  return {
    name: 'tower-copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      for (const dir of dirs) {
        const from = path.resolve(dir);
        if (!fs.existsSync(from)) continue;
        const to = path.resolve('dist', dir);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true });
        const count = fs.readdirSync(to, { recursive: true }).length;
        this.info(`copied ${dir} (${count} files)`);
      }
    },
  };
}

export default defineConfig({
  root: '.',
  // Relative, so a build runs from a subdirectory, a file server, or inside a
  // desktop wrapper without being rebuilt for each.
  base: './',
  plugins: [copyRuntimeAssets(['src/games/tower/assets'])],
  build: {
    rollupOptions: {
      input: {
        // One game here, deliberately. The rig can hold more; this one is about
        // matching a single reference implementation.
        tower: 'src/games/tower/index.html',
      },
    },
  },
  server: {
    port: 5174,
  },
});
