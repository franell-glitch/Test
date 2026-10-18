'use strict';

const DESCRIPTOR_LENGTH = 128;

function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === DESCRIPTOR_LENGTH && d.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Sucht unter allen gespeicherten Gesichtern die Person mit dem geringsten Abstand.
 * Liefert null, wenn niemand unter dem Schwellwert liegt.
 */
function findBestMatch(descriptor, candidates, threshold) {
  let best = null;
  for (const c of candidates) {
    const distance = euclideanDistance(descriptor, c.descriptor);
    if (!best || distance < best.distance) best = { userId: c.userId, distance };
  }
  return best && best.distance < threshold ? best : null;
}

module.exports = { isValidDescriptor, euclideanDistance, findBestMatch };
