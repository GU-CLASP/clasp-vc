import raccoonHeadModel from "./avatars/raccoon_head_small.glb?url";
import rpmAvatar from "./avatars/rpm_avatar.glb?url";
import babyModel from "./avatars/baby.glb?url";
import babyModelLower from "./avatars/babylower.glb?url";
import babyModel2 from "./avatars/Untitled.glb?url";

export const modelOptions = [
  {
    name: "BabyLow",
    model: babyModelLower,
    cameraConfig: {
      target: [0, 3, -1.2],
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
