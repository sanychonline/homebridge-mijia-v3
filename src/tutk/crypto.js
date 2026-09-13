"use strict";

const CHARLIE = Buffer.from("Charlie is the designer of P2P!!", "ascii");

function reverseTransCodePartial(source) {
  const src = Buffer.from(source);
  const dst = Buffer.alloc(src.length);
  const tmp = Buffer.alloc(src.length);
  let offset = 0;
  let remaining = src.length;

  while (remaining >= 16) {
    for (let i = 0; i !== 16; i += 4) {
      tmp.writeUInt32LE(rotateLeft32(src.readUInt32LE(offset + i), i + 3), offset + i);
    }

    swap(dst, offset, tmp, offset, 16);

    for (let i = 0; i !== 16; i++) {
      tmp[offset + i] = dst[offset + i] ^ CHARLIE[i];
    }

    for (let i = 0; i !== 16; i += 4) {
      dst.writeUInt32LE(rotateLeft32(tmp.readUInt32LE(offset + i), i + 1), offset + i);
    }

    offset += 16;
    remaining -= 16;
  }

  swap(tmp, offset, src, offset, remaining);
  for (let i = 0; i < remaining; i++) {
    dst[offset + i] = tmp[offset + i] ^ CHARLIE[i];
  }

  return dst;
}

function transCodePartial(source) {
  const src = Buffer.from(source);
  const dst = Buffer.alloc(src.length);
  const tmp = Buffer.alloc(src.length);
  let offset = 0;
  let remaining = src.length;

  while (remaining >= 16) {
    for (let i = 0; i !== 16; i += 4) {
      tmp.writeUInt32LE(rotateLeft32(src.readUInt32LE(offset + i), -i - 1), offset + i);
    }

    for (let i = 0; i !== 16; i++) {
      dst[offset + i] = tmp[offset + i] ^ CHARLIE[i];
    }

    swap(tmp, offset, dst, offset, 16);

    for (let i = 0; i !== 16; i += 4) {
      dst.writeUInt32LE(rotateLeft32(tmp.readUInt32LE(offset + i), -i - 3), offset + i);
    }

    offset += 16;
    remaining -= 16;
  }

  for (let i = 0; i < remaining; i++) {
    tmp[offset + i] = src[offset + i] ^ CHARLIE[i];
  }
  swap(dst, offset, tmp, offset, remaining);

  return dst;
}

function reverseTransCodeBlob(source) {
  const src = Buffer.from(source);
  if (src.length < 16) {
    return reverseTransCodePartial(src);
  }

  const dst = Buffer.alloc(src.length);
  reverseTransCodePartial(src.subarray(0, 16)).copy(dst);

  if (src.length <= 16) {
    return dst;
  }

  if ((dst[3] & 1) !== 0) {
    const decryptLength = Math.min(src.length - 16, 48);
    if (decryptLength > 0) {
      reverseTransCodePartial(src.subarray(16, 16 + decryptLength)).copy(dst, 16);
    }
    if (src.length > 64) {
      src.copy(dst, 64, 64);
    }
    return dst;
  }

  reverseTransCodePartial(src.subarray(16)).copy(dst, 16);
  return dst;
}

function transCodeBlob(source) {
  const src = Buffer.from(source);
  if (src.length < 16) {
    return transCodePartial(src);
  }

  const dst = Buffer.alloc(src.length);
  transCodePartial(src.subarray(0, 16)).copy(dst);

  if (src.length <= 16) {
    return dst;
  }

  if ((src[3] & 1) !== 0) {
    const encryptLength = Math.min(src.length - 16, 48);
    if (encryptLength > 0) {
      transCodePartial(src.subarray(16, 16 + encryptLength)).copy(dst, 16);
    }
    if (src.length > 64) {
      src.copy(dst, 64, 64);
    }
    return dst;
  }

  transCodePartial(src.subarray(16)).copy(dst, 16);
  return dst;
}

function swap(dst, dstOffset, src, srcOffset, length) {
  switch (length) {
    case 2:
      dst[dstOffset] = src[srcOffset + 1];
      dst[dstOffset + 1] = src[srcOffset];
      return;
    case 4:
      dst[dstOffset] = src[srcOffset + 2];
      dst[dstOffset + 1] = src[srcOffset + 3];
      dst[dstOffset + 2] = src[srcOffset];
      dst[dstOffset + 3] = src[srcOffset + 1];
      return;
    case 8:
      dst[dstOffset] = src[srcOffset + 7];
      dst[dstOffset + 1] = src[srcOffset + 4];
      dst[dstOffset + 2] = src[srcOffset + 3];
      dst[dstOffset + 3] = src[srcOffset + 2];
      dst[dstOffset + 4] = src[srcOffset + 1];
      dst[dstOffset + 5] = src[srcOffset + 6];
      dst[dstOffset + 6] = src[srcOffset + 5];
      dst[dstOffset + 7] = src[srcOffset];
      return;
    case 16:
      dst[dstOffset] = src[srcOffset + 11];
      dst[dstOffset + 1] = src[srcOffset + 9];
      dst[dstOffset + 2] = src[srcOffset + 8];
      dst[dstOffset + 3] = src[srcOffset + 15];
      dst[dstOffset + 4] = src[srcOffset + 13];
      dst[dstOffset + 5] = src[srcOffset + 10];
      dst[dstOffset + 6] = src[srcOffset + 12];
      dst[dstOffset + 7] = src[srcOffset + 14];
      dst[dstOffset + 8] = src[srcOffset + 2];
      dst[dstOffset + 9] = src[srcOffset + 1];
      dst[dstOffset + 10] = src[srcOffset + 5];
      dst[dstOffset + 11] = src[srcOffset];
      dst[dstOffset + 12] = src[srcOffset + 6];
      dst[dstOffset + 13] = src[srcOffset + 4];
      dst[dstOffset + 14] = src[srcOffset + 7];
      dst[dstOffset + 15] = src[srcOffset + 3];
      return;
    default:
      src.copy(dst, dstOffset, srcOffset, srcOffset + length);
  }
}

function rotateLeft32(value, shift) {
  const normalized = ((shift % 32) + 32) % 32;
  return ((value << normalized) | (value >>> (32 - normalized))) >>> 0;
}

module.exports = {
  reverseTransCodeBlob,
  reverseTransCodePartial,
  transCodeBlob,
  transCodePartial,
};
