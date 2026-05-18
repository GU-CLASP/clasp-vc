import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Aniface } from "aniface";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getHeadRotationDamping(model) {
  const damping = model?.headRotationDamping;

  if (typeof damping === "number") {
    return {
      pitch: damping,
      yaw: damping,
      roll: damping,
    };
  }

  return {
    pitch: numberOrDefault(damping?.pitch, 1),
    yaw: numberOrDefault(damping?.yaw, 1),
    roll: numberOrDefault(damping?.roll, 1),
  };
}

function createHeadRotationDampener(model) {
  const { pitch, yaw, roll } = getHeadRotationDamping(model);

  if (pitch === 1 && yaw === 1 && roll === 1) {
    return (results) => results;
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const euler = new Euler();

  return (results) => {
    const facialTransformationMatrixes = results?.facialTransformationMatrixes;
    if (!facialTransformationMatrixes?.length) {
      return results;
    }

    return {
      ...results,
      facialTransformationMatrixes: facialTransformationMatrixes.map((faceMatrix) => {
        const data = faceMatrix?.data;
        if (!data || data.length < 16) {
          return faceMatrix;
        }

        matrix.fromArray(data);
        matrix.decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion);
        euler.set(euler.x * pitch, euler.y * yaw, euler.z * roll);
        quaternion.setFromEuler(euler);
        matrix.compose(position, quaternion, scale);

        const dampedData = Array.from(data);
        matrix.toArray(dampedData);

        return {
          ...faceMatrix,
          data: dampedData,
        };
      }),
    };
  };
}

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
    blendshapeMultipliers: model.blendshapeMultipliers,
    modelOptions: model.modelOptions,
    // No videoElement needed when using custom MediaPipe
  });
  await avatar.initialize();
  const dampenHeadRotation = createHeadRotationDampener(model);

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

    const results = dampenHeadRotation(myLandmarker.detectForVideo(video, performance.now()));
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
