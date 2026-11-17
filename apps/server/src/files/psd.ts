// A minimal Photoshop (.psd) writer for layer stacks: 8-bit RGB, one pixel layer per image with
// its own transparency, and the flattened picture for apps that only read that. Channels are
// PackBits compressed, which keeps the empty space around a cropped layer small. Written from
// Adobe's "Photoshop File Formats Specification" (the PSD sections only; no PSB, no masks).

export interface PsdLayer {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** width × height × 4 bytes, RGBA, straight (not premultiplied) alpha. */
  rgba: Uint8Array;
  hidden?: boolean;
}

export interface PsdDocument {
  width: number;
  height: number;
  /** Bottom first, as Photoshop lists them in the file. */
  layers: readonly PsdLayer[];
  /** The flattened picture, width × height × 4 bytes RGBA. */
  composite: Uint8Array;
}

/** PSD's own limit; past it a file must be a PSB. */
export const PSD_MAX_EDGE = 30_000;

class Writer {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  bytes(data: Uint8Array): this {
    this.#chunks.push(data);
    this.#length += data.byteLength;
    return this;
  }

  u8(n: number): this {
    return this.bytes(Uint8Array.of(n & 0xff));
  }

  u16(n: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n);
    return this.bytes(b);
  }

  i16(n: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, n);
    return this.bytes(b);
  }

  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return this.bytes(b);
  }

  i32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n);
    return this.bytes(b);
  }

  ascii(text: string): this {
    return this.bytes(new TextEncoder().encode(text));
  }

  pad(to: number): this {
    while (this.#length % to) this.u8(0);
    return this;
  }

  /** A section that starts with its own length, as a 4-byte count. */
  section(build: (w: Writer) => void, padTo = 1): this {
    const inner = new Writer();
    build(inner);
    inner.pad(padTo);
    return this.u32(inner.length).bytes(inner.toBytes());
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/** PackBits, as the spec and TIFF use it: runs of 2 to 128 repeats, or literal stretches of up to 128. */
export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run > 1) {
      out.push(257 - run, row[i]!);
      i += run;
      continue;
    }
    const start = i;
    while (i < row.length && i - start < 128 && !(i + 1 < row.length && row[i] === row[i + 1])) i++;
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(row[k]!);
  }
  return Uint8Array.from(out);
}

/** One channel of RGBA pixels, packed row by row: the row lengths, then the rows. */
function packedChannel(rgba: Uint8Array, width: number, height: number, channel: number) {
  const rows: Uint8Array[] = [];
  const row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x] = rgba[(y * width + x) * 4 + channel]!;
    rows.push(packBits(row));
  }
  return rows;
}

const CHANNELS = [
  { id: -1, at: 3 },
  { id: 0, at: 0 },
  { id: 1, at: 1 },
  { id: 2, at: 2 },
] as const;

export function writePsd(doc: PsdDocument): Uint8Array {
  const { width, height } = doc;
  if (width < 1 || height < 1 || width > PSD_MAX_EDGE || height > PSD_MAX_EDGE) {
    throw new RangeError(`A PSD is 1 to ${PSD_MAX_EDGE} pixels a side, not ${width}x${height}`);
  }
  const w = new Writer();
  // Header: signature, version 1, six reserved bytes, 4 channels (RGB and alpha), 8 bits, RGB.
  w.ascii("8BPS").u16(1).bytes(new Uint8Array(6)).u16(4).u32(height).u32(width).u16(8).u16(3);
  w.u32(0); // colour mode data
  w.u32(0); // image resources

  // Each layer's channels, packed now: the records need their lengths.
  const packed = doc.layers.map((layer) =>
    CHANNELS.map((c) => {
      if (layer.width < 1 || layer.height < 1) return { id: c.id, rows: [] as Uint8Array[], length: 2 };
      const rows = packedChannel(layer.rgba, layer.width, layer.height, c.at);
      return { id: c.id, rows, length: 2 + rows.length * 2 + rows.reduce((s, r) => s + r.byteLength, 0) };
    }),
  );

  w.section((info) => {
    info.section((layers) => {
      // A negative count says the first alpha channel is the merged picture's transparency.
      layers.i16(-doc.layers.length);
      for (const [i, layer] of doc.layers.entries()) {
        layers
          .i32(layer.top)
          .i32(layer.left)
          .i32(layer.top + layer.height)
          .i32(layer.left + layer.width);
        layers.u16(CHANNELS.length);
        for (const channel of packed[i]!) layers.i16(channel.id).u32(channel.length);
        layers.ascii("8BIM").ascii("norm").u8(255).u8(0);
        // Bit 1 hides the layer; bit 3 says bit 4 is in use (Photoshop 5.0 and later).
        layers.u8(layer.hidden ? 0b0000_1010 : 0b0000_1000).u8(0);
        layers.section((extra) => {
          extra.u32(0); // no layer mask
          extra.u32(0); // no blending ranges
          const name = asciiName(layer.name);
          extra.u8(name.length).bytes(name).pad(4);
          // The full name, in UTF-16, for names Pascal strings can't hold.
          extra
            .ascii("8BIM")
            .ascii("luni")
            .section((u) => {
              const units = [...layer.name].flatMap((ch) => {
                const code = ch.codePointAt(0)!;
                if (code < 0x10000) return [code];
                const v = code - 0x10000;
                return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
              });
              u.u32(units.length);
              for (const unit of units) u.u16(unit);
            }, 4);
        });
      }
      for (const channels of packed) {
        for (const channel of channels) {
          layers.u16(1);
          for (const row of channel.rows) layers.u16(row.byteLength);
          for (const row of channel.rows) layers.bytes(row);
        }
      }
    }, 2);
    info.u32(0); // no global layer mask
  });

  // The flattened picture: RLE, every row length for all four channels, then the rows. R, G, B, A.
  const merged = [0, 1, 2, 3].map((c) => packedChannel(doc.composite, width, height, c));
  w.u16(1);
  for (const rows of merged) for (const row of rows) w.u16(row.byteLength);
  for (const rows of merged) for (const row of rows) w.bytes(row);
  return w.toBytes();
}

/** The name as a Pascal string can hold it: 255 bytes at most, anything past ASCII as "?". */
function asciiName(name: string): Uint8Array {
  const out = [...name].slice(0, 255).map((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 0x20 && code < 0x7f ? code : 0x3f;
  });
  return Uint8Array.from(out);
}
