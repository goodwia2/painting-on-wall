// The paintings shown in the picker.
// width / height are the real canvas size in centimetres (width × height).
// To add a painting: put a large image in artworks/ and a small one in
// artworks/thumbs/ with the same file name, then add a line below.
export const ARTWORKS = [
  { id: "amsterdam",        title: "Amsterdam",         width: 31,  height: 36 },
  { id: "cecile-brunner",   title: "Cécile Brunner",    width: 40,  height: 50 },
  { id: "daffodils",        title: "Daffodils",         width: 40,  height: 50 },
  { id: "garden",           title: "Garden",            width: 123, height: 92 },
  { id: "glendhu-bay",      title: "Glendhu Bay",       width: 75,  height: 50 },
  { id: "hydrangea",        title: "Hydrangea",         width: 70,  height: 50 }, // size estimated
  { id: "landscape-wanaka", title: "Landscape, Wānaka", width: 75,  height: 50 },
  { id: "lemons",           title: "Lemons",            width: 60,  height: 40 }, // size estimated
  { id: "roses",            title: "Roses",             width: 59,  height: 75 },
].map((a) => ({
  ...a,
  image: `artworks/${a.id}.jpg`,
  thumb: `artworks/thumbs/${a.id}.jpg`,
}));

// Thin float frames. width = visible frame face, gap = shadow gap between the
// canvas and the frame (both in cm). light/mid/dark shade the frame edges as if
// lit from above.
export const FRAMES = {
  none:  { label: "No frame", width: 0, gap: 0, color: null },
  black: {
    label: "Black", width: 1.5, gap: 0.5, color: "#1e1e1e",
    light: "#4a4a4a", mid: "#262626", dark: "#0f0f0f", gapColor: "#0a0a0a",
  },
  white: {
    label: "White", width: 1.5, gap: 0.5, color: "#f3f1ec",
    light: "#ffffff", mid: "#ebe8e2", dark: "#d3cec5", gapColor: "#b8b2a7",
  },
};
