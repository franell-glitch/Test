// Gemeinsame Funktionen für Kamera und Gesichtserkennung (face-api.js im Browser)
/* global faceapi */
'use strict';

const Face = (() => {
  let modelsLoaded = null;

  function loadModels() {
    if (!modelsLoaded) {
      modelsLoaded = Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      ]);
    }
    return modelsLoaded;
  }

  async function startCamera(video) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kamera nicht verfügbar. Die Seite muss über HTTPS oder localhost geöffnet werden.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.onloadeddata = () => resolve();
    });
    await video.play();
    return stream;
  }

  function stopCamera(video) {
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  const detectorOptions = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 });

  /**
   * Erkennt genau ein Gesicht und liefert { descriptor, box } oder null.
   * Bei mehreren Gesichtern wird ein Fehler mit code 'MULTIPLE' geworfen.
   */
  async function detectSingle(input) {
    const results = await faceapi.detectAllFaces(input, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (results.length === 0) return null;
    if (results.length > 1) {
      const err = new Error('Mehrere Gesichter erkannt – bitte nur eine Person vor die Kamera.');
      err.code = 'MULTIPLE';
      throw err;
    }
    const r = results[0];
    return { descriptor: Array.from(r.descriptor), box: r.detection.box, score: r.detection.score };
  }

  /** Schneidet das Gesicht als kleines JPEG-Vorschaubild aus. */
  function thumbnail(source, box, size = 120) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const pad = Math.max(box.width, box.height) * 0.3;
    const side = Math.max(box.width, box.height) + pad * 2;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    canvas.getContext('2d').drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  /** Zeichnet den Gesichtsrahmen über das Video. */
  function drawBox(canvas, video, box, color) {
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!box) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }

  return { loadModels, startCamera, stopCamera, detectSingle, thumbnail, drawBox };
})();
