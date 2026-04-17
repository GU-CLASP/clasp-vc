import raccoonHeadModel from "./avatars/raccoon_head_small.glb?url";
import rpmAvatar from "./avatars/rpm_avatar.glb?url";

export const modelOptions = [
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
