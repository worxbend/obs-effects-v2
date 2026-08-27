/**
 * Just enough PNG reading to answer one question: **did this effect actually draw anything?**
 *
 * ## Why a screenshot rather than reading the canvas
 *
 * The obvious way to check a WebGL canvas is to ask it for its pixels with `gl.readPixels`. It
 * does not work here. A WebGL drawing buffer is thrown away as soon as the browser has composited
 * it, unless the context was created with `preserveDrawingBuffer: true` — which none of the
 * effects do, because it costs performance for no benefit on a live stream. Reading such a buffer
 * from outside the effect's own animation frame gives back transparent black, whatever is on
 * screen.
 *
 * A screenshot is taken after compositing, so it shows what a viewer sees. The renderer page is
 * deliberately transparent, so a screenshot taken with `omitBackground: true` has an alpha channel
 * in which **every non-zero pixel is something the effect drew**. That turns "is it blank?" into
 * counting bytes, with no threshold to argue about.
 *
 * ## Why the decoder is written out here
 *
 * The Playwright image has Node and nothing else installed, and this needs about sixty lines: PNG
 * stores its pixels zlib-compressed (which Node's own `zlib` undoes) behind a per-scanline filter
 * that has to be reversed. Only what Chromium actually emits is supported — 8 bits per channel,
 * no interlacing — and anything else throws rather than returning a wrong answer.
 */

import { inflateSync } from "node:zlib";

/** The eight bytes every PNG file starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** How many channels each PNG colour type stores per pixel. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes a PNG buffer into `{ width, height, channels, data }`.
 *
 * `data` is one byte per channel per pixel, row-major, with no padding — so pixel (x, y) starts at
 * `(y * width + x) * channels`.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG: the file does not start with the PNG signature.");
  }

  let offset = 8;
  let header = null;
  const pixelChunks = [];

  // A PNG is a list of chunks: 4 bytes of length, 4 bytes of type, the data, 4 bytes of checksum.
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      // The compressed stream may be split across any number of IDAT chunks; they concatenate.
      pixelChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!header) throw new Error("Not a usable PNG: it has no IHDR chunk.");
  if (header.bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${header.bitDepth}; this reader handles 8 only.`);
  }
  if (header.interlace !== 0) {
    throw new Error("Unsupported interlaced PNG; this reader handles non-interlaced only.");
  }

  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${header.colorType}.`);

  const raw = inflateSync(Buffer.concat(pixelChunks));
  const { width, height } = header;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  /*
   * Undo the per-scanline filter.
   *
   * Every row is stored with one leading byte saying how it was transformed, to make the row
   * compress better. Reversing it needs the byte to the left (`a`), the byte above (`b`) and the
   * byte above-left (`c`); outside the image those are all zero. The five filter types are the
   * whole of the PNG specification's section 9.
   */
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const a = x >= channels ? out[target + x - channels] : 0;
      const b = y > 0 ? out[target - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[target - stride + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4: {
          // "Paeth": pick whichever of the three neighbours predicts the value best.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Unknown PNG row filter ${filter} on row ${y}.`);
      }
      out[target + x] = restored & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/**
 * Summarises a screenshot: how much of it is painted, and how varied that paint is.
 *
 * `paintedFraction` is the share of pixels with a non-zero alpha channel, which on a screenshot
 * taken with `omitBackground: true` means "the page drew here". `distinctColours` is capped
 * because the only question is whether there is more than one, and counting every shade of a
 * gradient would allocate for nothing.
 *
 * An image with no alpha channel (colour type 2, which Chromium emits when the background is not
 * omitted) is treated as fully painted, and only `distinctColours` is meaningful.
 */
export function summarisePng(buffer, { colourCap = 4096 } = {}) {
  const image = decodePng(buffer);
  const { width, height, channels, data } = image;
  const pixels = width * height;
  const hasAlpha = channels === 4 || channels === 2;

  let painted = 0;
  const colours = new Set();

  for (let i = 0; i < pixels; i += 1) {
    const at = i * channels;
    const alpha = hasAlpha ? data[at + channels - 1] : 255;
    if (alpha === 0) continue;
    painted += 1;
    if (colours.size < colourCap) {
      colours.add(data.subarray(at, at + channels).toString("hex"));
    }
  }

  return {
    width,
    height,
    pixels,
    painted,
    paintedFraction: pixels === 0 ? 0 : painted / pixels,
    distinctColours: colours.size,
  };
}
