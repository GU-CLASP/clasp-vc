import raccoonHeadModel from "./avatars/raccoon_head_small.glb?url";
import rpmAvatar from "./avatars/rpm_avatar.glb?url";
import babyModel from "./avatars/baby.glb?url";
import babyModel2 from "./avatars/Untitled.glb?url";
import zhenja from "./avatars/zhenja.glb?url";

export const modelOptions = [
  {
    name: "Babyglb",
    model: babyModel,
    cameraConfig: {
      fov: 60,
      position: [0, 0, 6.2],
      target: [0, 0, 0],
    },
    blendshapeMultipliers: {
      browOuterUpLeft: 2.0,
      browOuterUpRight: 2.0,
    },
    modelOptions: {
      scale: 0.4,
    }
  },
  {
    name: "Baby2",
    model: babyModel2,
    cameraConfig: {
      fov: 60,
      position: [0, -3, 6.2],
      target: [0, 0, 0]
    },
    modelOptions: {
      scale: 0.4,
    }
  },
  {
    name: "Zhenja",
    model: zhenja,
    cameraConfig: {
      fov: 60,
      position: [0, 1.65, 1.2],
      target: [0, 1.6, 0]
    },
    modelOptions: {
      center: true,
      autoRotate: false,
      scale: 1.8,
      fullBodyAvatar: true
    }
  },
  {
    name: "Raccoon",
    model: raccoonHeadModel,
  },
  {
    name: "Ready Player Me",
    model: rpmAvatar,
    cameraConfig: {
      fov: 60,
      position: [0, 1.65, 1.2],
      target: [0, 1.6, 0]
    },
    modelOptions: {
      scale: 1.8,
      center: true,
      autoRotate: false,
      rotation: 0,
      position: [0, -0.5, 0],
      fullBodyAvatar: true
    }
  },
];
