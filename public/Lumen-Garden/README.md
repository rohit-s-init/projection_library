# Lumen Garden
A 3D light-routing puzzle game built on Rohit Sawant's Projection 3D library.

## Play
1. Extract this ZIP. Copy the entire `Lumen-Garden` folder into your repository's `public` directory.
2. Start your existing server with `node index.js`.
3. Open http://localhost:9600/Lumen-Garden/ (use your configured port if different).

Do not double-click index.html: JavaScript modules need an HTTP server.
No npm packages, build step, CDN, images, fonts or paid services are required.
You can also serve the extracted folder with `python -m http.server 9600`.

## Rules
Rotate islands so their paths meet. Light begins at the golden spring. Wake every floating crystal and connect the pink portal to finish. Not every island needs to be lit. Each level is a deterministic randomized spanning-tree puzzle, so a solution always exists. Gardens 1–2 are 4×4; later gardens are 5×5, with more crystal targets over time.

- Click/tap: clockwise rotation; right-click: counterclockwise.
- Z / Undo: reverse the last rotation.
- H / Hint: align one island to the generated solution (3 per level).
- Reset: restart the current garden.
- Sound: optional synthesized chimes; no audio downloads.
- Progress: highest unlocked garden and best stars saved locally in this browser.
- Three stars: no hints and rotations at or below the generated solution's reference move count. Two stars: at most one hint and within 160% of that count. Otherwise one star. This reference is not a proven global optimum.

## Files / integration
- `game.js`: interaction, animation, mesh generation, audio, HUD, progress.
- `puzzle.js`: seeded puzzle generation and network traversal.
- `renderer.js`: adapter extending the actual `Space` class from Projection 3D.
- `vendor/`: bundled Projection 3D source from rohit-s-init/projection_library, main commit ced4ce43a625448b36cd6ba49d3fa82e10442124.
- `index.html`, `style.css`: responsive UI.

The original camera basis, orbit geometry and vector projection are used directly. The adapter provides a perspective-correct shader, dynamic buffers and procedural meshes. The bundled Space.js fixes the Face.js import's filename case and disables its demo keyboard shortcuts to prevent interference. Your existing library files are never overwritten. No Three.js or other 3D engine is used.

Designed for desktop and touch browsers with WebGL. Puzzle state within an unfinished garden resets on refresh; completed progression persists. Sounds are effects, not a soundtrack. There is no backend, telemetry, online leaderboard or network requirement after loading.
