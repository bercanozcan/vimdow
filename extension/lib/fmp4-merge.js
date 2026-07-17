// fmp4-merge.js — merges a video-only and an audio-only fragmented MP4
// stream (init segment + media segments, as served by Vimeo HLS) into a
// single playable fragmented MP4 with two tracks.
//
// Works by box surgery, no re-encoding:
//   - new moov = video mvhd + video trak + audio trak (track id remapped)
//                + combined mvex (both trex boxes)
//   - fragments (moof+mdat) are copied verbatim, interleaved by decode time,
//     with track ids and sequence numbers rewritten
//
// Usable both from Node (for tests) and the browser (offscreen document).

"use strict";

// ---- byte helpers ----

function u32(buf, off) {
  return (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
}

function setU32(buf, off, val) {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function u64(buf, off) {
  return u32(buf, off) * 4294967296 + u32(buf, off + 4);
}

function setU64(buf, off, val) {
  setU32(buf, off, Math.floor(val / 4294967296));
  setU32(buf, off + 4, val >>> 0);
}

function boxType(buf, off) {
  return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
}

// Iterates top-level boxes of a buffer region. Returns [{type, start, size}].
function listBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = u32(buf, off);
    const type = boxType(buf, off);
    if (size === 1) size = u64(buf, off + 8); // 64-bit largesize
    if (size < 8 || off + size > end) break;
    out.push({ type, start: off, size });
    off += size;
  }
  return out;
}

function findBox(buf, path, start = 0, end = buf.length) {
  let boxes = listBoxes(buf, start, end);
  let box = null;
  for (const type of path) {
    box = boxes.find((b) => b.type === type);
    if (!box) return null;
    boxes = listBoxes(buf, box.start + 8, box.start + box.size);
  }
  return box;
}

function slice(buf, box) {
  return buf.subarray(box.start, box.start + box.size);
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function wrapBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  setU32(out, 0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

// ---- field rewrites (offsets per ISO 14496-12) ----

function remapTrakId(trak, newId) {
  // `trak` is the box itself, so the search path starts at "trak"
  const tkhd = findBox(trak, ["trak", "tkhd"]);
  if (!tkhd) throw new Error("tkhd not found");
  const version = trak[tkhd.start + 8];
  const idOff = tkhd.start + (version === 1 ? 28 : 20); // header + fullbox + times
  setU32(trak, idOff, newId);
}

function remapTrexId(trex, newId) {
  setU32(trex, 12, newId); // FullBox header then track_ID
}

function getMdhdTimescale(trakBuf) {
  const mdhd = findBox(trakBuf, ["trak", "mdia", "mdhd"]);
  if (!mdhd) throw new Error("mdhd not found");
  const version = trakBuf[mdhd.start + 8];
  return u32(trakBuf, mdhd.start + (version === 1 ? 28 : 20));
}

// ---- fragment parsing ----

// Extracts {moof, mdat, decodeTime} pairs from a media segment buffer,
// skipping styp/sidx/prft/emsg boxes.
function parseFragments(segBuf) {
  const pairs = [];
  let pendingMoof = null;
  for (const box of listBoxes(segBuf)) {
    if (box.type === "moof") pendingMoof = box;
    else if (box.type === "mdat" && pendingMoof) {
      pairs.push({ moof: slice(segBuf, pendingMoof), mdat: slice(segBuf, box) });
      pendingMoof = null;
    }
  }
  return pairs;
}

function getDecodeTime(moof) {
  const tfdt = findBox(moof, ["moof", "traf", "tfdt"]);
  if (!tfdt) return 0;
  const version = moof[tfdt.start + 8];
  return version === 1 ? u64(moof, tfdt.start + 12) : u32(moof, tfdt.start + 12);
}

// Rewrites track_ID inside every tfhd of a moof (in place).
function remapMoofTrackId(moof, newId) {
  for (const traf of listBoxes(moof, 8, moof.length).filter((b) => b.type === "traf")) {
    const tfhd = listBoxes(moof, traf.start + 8, traf.start + traf.size).find((b) => b.type === "tfhd");
    if (tfhd) setU32(moof, tfhd.start + 12, newId);
  }
}

function setMoofSequence(moof, seq) {
  const mfhd = listBoxes(moof, 8, moof.length).find((b) => b.type === "mfhd");
  if (mfhd) setU32(moof, mfhd.start + 12, seq);
}

// If tfhd carries an absolute base_data_offset (flag 0x1), rewrite it to the
// new absolute position of the moof. No-op for default-base-is-moof (0x20000).
function fixBaseDataOffset(moof, newMoofAbsOffset) {
  for (const traf of listBoxes(moof, 8, moof.length).filter((b) => b.type === "traf")) {
    const tfhd = listBoxes(moof, traf.start + 8, traf.start + traf.size).find((b) => b.type === "tfhd");
    if (!tfhd) continue;
    const flags = u32(moof, tfhd.start + 8) & 0xffffff;
    if (flags & 0x1) setU64(moof, tfhd.start + 16, newMoofAbsOffset);
  }
}

// ---- main entry ----

/**
 * @param {Uint8Array} videoInit  init segment of the video track
 * @param {Uint8Array[]} videoSegs media segments of the video track (in order)
 * @param {Uint8Array} audioInit  init segment of the audio track
 * @param {Uint8Array[]} audioSegs media segments of the audio track (in order)
 * @returns {Uint8Array} single fragmented MP4 with both tracks
 */
function mergeFmp4(videoInit, videoSegs, audioInit, audioSegs) {
  const VIDEO_ID = 1;
  const AUDIO_ID = 2;

  // --- build moov ---
  const vFtyp = findBox(videoInit, ["ftyp"]);
  const vMoov = findBox(videoInit, ["moov"]);
  const aMoov = findBox(audioInit, ["moov"]);
  if (!vMoov || !aMoov) throw new Error("moov not found in init segment");

  const vMoovChildren = listBoxes(videoInit, vMoov.start + 8, vMoov.start + vMoov.size);
  const aMoovChildren = listBoxes(audioInit, aMoov.start + 8, aMoov.start + aMoov.size);

  const mvhd = new Uint8Array(slice(videoInit, vMoovChildren.find((b) => b.type === "mvhd")));
  const vTrak = new Uint8Array(slice(videoInit, vMoovChildren.find((b) => b.type === "trak")));
  const aTrak = new Uint8Array(slice(audioInit, aMoovChildren.find((b) => b.type === "trak")));
  const vMvex = vMoovChildren.find((b) => b.type === "mvex");
  const aMvex = aMoovChildren.find((b) => b.type === "mvex");
  if (!vMvex || !aMvex) throw new Error("mvex not found in init segment");

  remapTrakId(vTrak, VIDEO_ID);
  remapTrakId(aTrak, AUDIO_ID);
  setU32(mvhd, mvhd.length - 4, 3); // next_track_ID

  const vTrex = new Uint8Array(
    slice(videoInit, listBoxes(videoInit, vMvex.start + 8, vMvex.start + vMvex.size).find((b) => b.type === "trex"))
  );
  const aTrex = new Uint8Array(
    slice(audioInit, listBoxes(audioInit, aMvex.start + 8, aMvex.start + aMvex.size).find((b) => b.type === "trex"))
  );
  remapTrexId(vTrex, VIDEO_ID);
  remapTrexId(aTrex, AUDIO_ID);

  const moov = wrapBox("moov", concat([mvhd, vTrak, aTrak, wrapBox("mvex", concat([vTrex, aTrex]))]));
  const ftyp = vFtyp ? slice(videoInit, vFtyp) : new Uint8Array(0);

  // --- collect fragments with timing ---
  const vTimescale = getMdhdTimescale(vTrak);
  const aTimescale = getMdhdTimescale(aTrak);

  function collect(segs, trackId, timescale) {
    const out = [];
    for (const seg of segs) {
      for (const { moof, mdat } of parseFragments(seg)) {
        const m = new Uint8Array(moof); // copy — we mutate ids/sequence
        remapMoofTrackId(m, trackId);
        out.push({ moof: m, mdat, time: getDecodeTime(m) / timescale });
      }
    }
    return out;
  }

  const vFrags = collect(videoSegs, VIDEO_ID, vTimescale);
  const aFrags = collect(audioSegs, AUDIO_ID, aTimescale);

  // --- interleave by decode time (two-pointer merge) ---
  const ordered = [];
  let vi = 0, ai = 0;
  while (vi < vFrags.length || ai < aFrags.length) {
    if (ai >= aFrags.length || (vi < vFrags.length && vFrags[vi].time <= aFrags[ai].time)) {
      ordered.push(vFrags[vi++]);
    } else {
      ordered.push(aFrags[ai++]);
    }
  }

  // --- assemble, fixing sequence numbers and absolute offsets ---
  const parts = [ftyp, moov];
  let offset = ftyp.length + moov.length;
  ordered.forEach((frag, i) => {
    setMoofSequence(frag.moof, i + 1);
    fixBaseDataOffset(frag.moof, offset);
    parts.push(frag.moof, frag.mdat);
    offset += frag.moof.length + frag.mdat.length;
  });

  return concat(parts);
}

if (typeof module !== "undefined") {
  module.exports = { mergeFmp4, listBoxes, findBox };
}
