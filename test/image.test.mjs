import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wholeImage, imageType } from "../lib/image.mjs";

test("real logos pass", () => {
  for (const f of ["web/public/hooker-token.png", "web/public/logo-full.png", "web/public/og-v3.png"]) {
    const b = readFileSync(new URL(`../${f}`, import.meta.url));
    assert.equal(imageType(b), "image/png"); assert.ok(wholeImage(b), f);
  }
});
test("the 4 Oct test token's PNG (right header, broken checksums) is refused", () => {
  const bad = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAgMAAAC5YVYYAAAACVBMVEVcwnqL3KIHFAtZ8wAWAAAAD0lEQVQI12NgYGBgYGQAAAAhAAE1sjl2AAAAAElFTkSuQmCC", "base64");
  assert.equal(imageType(bad), "image/png"); assert.equal(wholeImage(bad), false);
});
test("a truncated PNG, an HTML error page and a cut-off JPEG are refused", () => {
  const png = readFileSync(new URL("../web/public/hooker-token.png", import.meta.url));
  assert.equal(wholeImage(png.subarray(0, png.length - 20)), false);
  assert.equal(wholeImage(Buffer.from("<html>429 Too Many Requests</html>")), false);
  assert.equal(wholeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), false);
  assert.equal(wholeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])), true);
  // a phone JPEG with 500 bytes of vendor data after its end marker is still a whole image
  assert.equal(wholeImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), Buffer.alloc(500, 7)])), true);
});

test("a Uint8Array (how an upload arrives) is read like a Buffer", () => {
  const b = readFileSync(new URL("../web/public/hooker-token.png", import.meta.url));
  const u = new Uint8Array(b);
  assert.equal(imageType(u), "image/png"); assert.equal(wholeImage(u), true);
});
