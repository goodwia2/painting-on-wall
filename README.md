# See it on your wall

A single web page where visitors upload a photo of their room, choose one of
the paintings and a frame (none / black / white), and see it hung on their wall
at roughly true size. They can drag it around, resize it, and save or share the
result.

- **No server needed.** Plain HTML, CSS and JavaScript: no build step.
- **Private.** The photo never leaves the visitor's device.
- **Smart placement.** A small AI model ([SegFormer](https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512),
  ~4 MB, run in the browser with [Transformers.js](https://huggingface.co/docs/transformers.js))
  finds the wall, then centres the painting above a sofa/sideboard/bed, or over a
  picture that's already hanging. If the model can't load, it falls back to a
  sensible default spot.
- **True scale.** The room's scale is estimated from the photo (e.g. a sofa is
  about 2.1 m wide). All paintings keep their real sizes relative to each other;
  the "Size check" slider corrects the estimate.

## Preview on your Mac

Double-click **`Open preview.command`**. It opens the page at
http://localhost:8123. Close the Terminal window to stop it.

(Opening `index.html` directly doesn't work: browsers block parts of it for
files opened straight from disk.)

## Adding or changing paintings

1. Put a large image (about 1600 px on the long side, cropped to just the
   canvas) in `artworks/`, and a small copy (about 360 px) with the same name in
   `artworks/thumbs/`.
2. Add a line to `js/artworks.js` with its title and size in cm.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure |
| `styles.css` | Look and layout (mobile first, two columns on desktop) |
| `js/artworks.js` | List of paintings, sizes and frame options |
| `js/app.js` | Photo upload, dragging/pinching, frames, saving |
| `js/placement.js` | Wall detection and choosing where to hang the painting |

## Putting it online (GitHub Pages)

1. Create a new repository on GitHub and upload this folder's contents.
2. In the repository: **Settings → Pages → Deploy from a branch → `main` / root**.
3. The page will be live at `https://<your-username>.github.io/<repo-name>/`.
