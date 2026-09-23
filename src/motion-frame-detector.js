"use strict";

// Compare small grayscale frames. Estimate noise from the majority of the
// image, then count supported regions rather than isolated noisy pixels.
function analyzeMotionFrame(current, previous, options = {}) {
  const width = Math.floor(Number(options.width || 160));
  const height = Math.floor(Number(options.height || 90));
  const total = width * height;
  const difference = Math.max(1, Number(options.difference || 5));
  const minimumRegionPixels = Math.max(1, Math.floor(Number(options.minimumRegionPixels || 24)));
  const noiseMultiplier = Math.max(1, Number(options.noiseMultiplier || 4));
  const result = {
    valid: false,
    changedPercent: 0,
    rawChangedPercent: 0,
    effectiveDifference: difference,
    brightnessShift: 0,
    noiseMedian: 0,
    noiseMad: 0,
    largestRegionPixels: 0,
    regions: 0,
  };
  if (width < 3 || height < 3 || !Number.isFinite(total)
      || !Buffer.isBuffer(current) || !Buffer.isBuffer(previous)
      || current.length !== total || previous.length !== total) {
    return result;
  }

  const deltas = new Int16Array(total);
  const deltaHistogram = new Uint32Array(511);
  let rawChanged = 0;
  for (let index = 0; index < total; index += 1) {
    const delta = current[index] - previous[index];
    deltas[index] = delta;
    deltaHistogram[delta + 255] += 1;
    if (Math.abs(delta) >= difference) rawChanged += 1;
  }

  const brightnessShift = histogramMedian(deltaHistogram, total) - 255;
  const residuals = new Uint16Array(total);
  const residualHistogram = new Uint32Array(511);
  for (let index = 0; index < total; index += 1) {
    const residual = Math.abs(deltas[index] - brightnessShift);
    residuals[index] = residual;
    residualHistogram[residual] += 1;
  }
  const noiseMedian = histogramMedian(residualHistogram, total);
  const deviationHistogram = new Uint32Array(511);
  for (let value = 0; value < residualHistogram.length; value += 1) {
    deviationHistogram[Math.abs(value - noiseMedian)] += residualHistogram[value];
  }
  const noiseMad = histogramMedian(deviationHistogram, total);
  // The extra unit rejects a constant noise magnitude, including quantized
  // low-light noise for which the median absolute deviation can be zero.
  const effectiveDifference = Math.max(difference, noiseMedian + noiseMultiplier * noiseMad + 1);
  const candidates = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    candidates[index] = residuals[index] >= effectiveDifference ? 1 : 0;
  }

  const supported = new Uint8Array(total);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!candidates[index]) continue;
      let neighbors = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          neighbors += candidates[yy * width + xx];
        }
      }
      if (neighbors >= 4) supported[index] = 1;
    }
  }

  const queue = new Int32Array(total);
  let changed = 0;
  let largestRegionPixels = 0;
  let regions = 0;
  for (let origin = 0; origin < total; origin += 1) {
    if (!supported[origin]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = origin;
    supported[origin] = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          const adjacent = yy * width + xx;
          if (supported[adjacent]) {
            supported[adjacent] = 0;
            queue[tail++] = adjacent;
          }
        }
      }
    }
    largestRegionPixels = Math.max(largestRegionPixels, tail);
    if (tail >= minimumRegionPixels) {
      changed += tail;
      regions += 1;
    }
  }

  return {
    valid: true,
    changedPercent: changed * 100 / total,
    rawChangedPercent: rawChanged * 100 / total,
    effectiveDifference,
    brightnessShift,
    noiseMedian,
    noiseMad,
    largestRegionPixels,
    regions,
  };
}

function histogramMedian(histogram, count) {
  const lowTarget = Math.floor((count - 1) / 2);
  const highTarget = Math.floor(count / 2);
  let accumulated = 0;
  let low = -1;
  for (let index = 0; index < histogram.length; index += 1) {
    accumulated += histogram[index];
    if (low < 0 && accumulated > lowTarget) low = index;
    if (accumulated > highTarget) return Math.round((low + index) / 2);
  }
  return 0;
}

module.exports = { analyzeMotionFrame };
