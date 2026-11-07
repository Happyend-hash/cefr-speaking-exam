/** Materiallar: files are checked by their bytes, and links are signed and expire. */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-materials-tests-1234567890';
const { sniffMaterial, signLink, readLink } = await import('../services/Materials.js');

const bytes = (...parts) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

test('files are recognised by what they are, not by their name', () => {
  assert.equal(sniffMaterial(bytes('%PDF-1.7\n', new Array(20).fill(0)), 'notes.pdf').kind, 'pdf');
  assert.equal(sniffMaterial(bytes('%PDF-1.7\n', new Array(20).fill(0)), 'renamed.docx').kind, 'pdf');
  const zip = bytes([0x50, 0x4b, 0x03, 0x04], new Array(20).fill(0));
  assert.equal(sniffMaterial(zip, 'Part 3 phrases.docx').kind, 'word');
  assert.equal(sniffMaterial(zip, 'slides.pptx').kind, 'slides');
  assert.equal(sniffMaterial(zip, 'archive.zip'), null, 'a plain zip is refused');
  assert.equal(sniffMaterial(bytes('ID3', new Array(20).fill(0)), 'track.mp3').kind, 'audio');
  assert.equal(sniffMaterial(bytes([0, 0, 0, 0x20], 'ftypM4A ', new Array(12).fill(0)), 'a.m4a').kind, 'audio');
  assert.equal(sniffMaterial(bytes([0, 0, 0, 0x20], 'ftypisom', new Array(12).fill(0)), 'v.mp4').kind, 'video');
  assert.equal(sniffMaterial(bytes([0x89], 'PNG\r\n\x1a\n', new Array(12).fill(0)), 'x.png').kind, 'image');
  assert.equal(sniffMaterial(bytes('<html><script>alert(1)</script>'), 'evil.pdf'), null, 'html pretending to be a pdf is refused');
  assert.equal(sniffMaterial(bytes('MZ', new Array(30).fill(0)), 'setup.exe'), null);
});

test('a signed link opens its own file only, and stops working after 6 hours', () => {
  const id = '64b000000000000000000001';
  const now = Date.now();
  const token = signLink(id, now);
  assert.equal(readLink(token, now + 1000), id);
  assert.equal(readLink(token, now + 7 * 3600 * 1000), null, 'expired');
  const [enc, mac] = token.split('.');
  const other = Buffer.from(`64b000000000000000000002.${(now + 3600e3).toString(36)}`).toString('base64url');
  assert.equal(readLink(`${other}.${mac}`, now), null, 'another id with the same signature is refused');
  assert.equal(readLink(`${enc}.AAAA${mac.slice(4)}`, now), null, 'a changed signature is refused');
  assert.equal(readLink('nonsense', now), null);
});
