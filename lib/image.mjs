// Is this a WHOLE image a browser can draw? Magic bytes alone are not enough: on 4 Oct 2026 a test
// token's PNG had the right header and broken checksums, and every browser showed a broken image.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b, from, to) => { let c = 0xffffffff; for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// uploads arrive as a Uint8Array, gateway reads as a Buffer: both are read as a Buffer (no copy)
const asBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null, from the first bytes. */
export function imageType(b) {
  b = asBuf(b);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** True only for a complete, uncorrupted file of a type we serve. */
export function wholeImage(b) {
  b = asBuf(b);
  const type = imageType(b);
  if (type === "image/png") {
    // every chunk's CRC must match, and the file must reach IEND
    let i = 8;
    while (i + 12 <= b.length) {
      const n = b.readUInt32BE(i), end = i + 12 + n;
      if (end > b.length) return false;
      if (crc32(b, i + 4, i + 8 + n) !== b.readUInt32BE(i + 8 + n)) return false;
      if (b.toString("latin1", i + 4, i + 8) === "IEND") return true;
      i = end;
    }
    return false;
  }
  // ⚠ phones (Samsung, …) append data AFTER a JPEG's end marker: look for the marker anywhere after the header,
  // not only at the very end. A cut-off upload still lacks it.
  if (type === "image/jpeg") { for (let i = b.length - 2; i > 2; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) return true; return false; }
  if (type === "image/gif") return b.lastIndexOf(0x3b) > 12; // the GIF trailer, wherever trailing data puts it
  if (type === "image/webp") return b.readUInt32LE(4) + 8 <= b.length;
  return false;
}
