export function dimensions(source) {
  return [
    source.videoWidth || source.naturalWidth || source.width,
    source.videoHeight || source.naturalHeight || source.height
  ];
}

export function makeCanvas(width = 1, height = 1) {
  const canvas = document.createElement('canvas');
  resize(canvas, width, height);
  return canvas;
}

export function resize(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

// Accept grayscale PNGs from SAM and white-on-transparent brush masks.
export function maskToAlpha(source, width, height) {
  const result = makeCanvas(width, height);
  const context = result.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i + 3] *= pixels.data[i] / 255;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return result;
}
