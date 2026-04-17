import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Aniface } from "aniface";

async function waitForVideoFrame(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  await new Promise((resolve) => {
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      resolve();
    };

    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
  });
}

export async function avatarInit(video, canvas, model) {
  if (!(video instanceof HTMLVideoElement) || !(canvas instanceof HTMLCanvasElement)) {
    return () => {};
  }

  console.log(`Using model ${model.name}`);
  const avatar = new Aniface({
    canvasElement: canvas,
    modelPath: model.model,
    cameraConfig: model.cameraConfig,
    modelOptions: model.modelOptions,
    // No videoElement needed when using custom MediaPipe
  });
  await avatar.initialize();

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );
  // Create MediaPipe instance with custom configuration
  const myLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    minFaceDetectionConfidence: 0.7,
    minFacePresenceConfidence: 0.7,
    minTrackingConfidence: 0.7,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
    // ... other custom options
  });

  let cancelled = false;

  await waitForVideoFrame(video);

  // Manual animation loop with custom MediaPipe
  function animate() {
    if (cancelled) {
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
      requestAnimationFrame(animate);
      return;
    }

    const results = myLandmarker.detectForVideo(video, performance.now());
    if (timeIndex++ % 1000 == 20) {
      console.log(results);
    }
    avatar.processLandmarkData(results);
    requestAnimationFrame(animate);
  }
  animate();

  return () => {
    cancelled = true;
    myLandmarker.close();
  };
}
var timeIndex = 0;
