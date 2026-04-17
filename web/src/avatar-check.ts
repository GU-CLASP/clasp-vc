import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { modelOptions } from "./avatar-models.js";

export type CheckResult = {
  meshCount: number;
  morphMeshCount: number;
  headLikeBones: string[];
  arkitMatches: string[];
  allMorphTargetNames: string[];
};

type MorphTargetMesh = THREE.Mesh & {
  morphTargetDictionary?: Record<string, number>;
  morphTargetInfluences?: number[];
};

type LoadedGltf = {
  scene: THREE.Group;
};

const ARKIT_NAMES = [
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "mouthClose",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
  "tongueOut",
] as const;

function normalizeName(name: string): string {
  return name.replace(/[_\s-]/g, "").toLowerCase();
}

function isMorphTargetMesh(object: THREE.Object3D): Boolean {
  return object instanceof THREE.Mesh;
}

export function checkAvatarCompatibility(gltf: LoadedGltf): CheckResult {
  const headLikeBones = new Set<string>();
  const morphTargetNames = new Set<string>();
  let meshCount = 0;
  let morphMeshCount = 0;

  gltf.scene.traverse((object: any) => {
    const name = object.name || "";

    if (
      (object instanceof THREE.Bone || object instanceof THREE.SkinnedMesh) &&
      /head|neck|spine|jaw|face/i.test(name)
    ) {
      headLikeBones.add(name);
    }

    if (!isMorphTargetMesh(object)) {
      return;
    }

    meshCount += 1;

    const dict = object.morphTargetDictionary;
    const influences = object.morphTargetInfluences;

    if (!dict || !influences || Object.keys(dict).length === 0) {
      return;
    }

    morphMeshCount += 1;

    for (const morphTargetName of Object.keys(dict)) {
      morphTargetNames.add(morphTargetName);
    }
  });

  const allMorphTargetNames = [...morphTargetNames].sort((a, b) =>
    a.localeCompare(b),
  );

  const arkitMatches = allMorphTargetNames.filter((name) => {
    const normalized = normalizeName(name);
    return ARKIT_NAMES.some((arkitName) => normalizeName(arkitName) === normalized);
  });

  return {
    meshCount,
    morphMeshCount,
    headLikeBones: [...headLikeBones].sort((a, b) => a.localeCompare(b)),
    arkitMatches: arkitMatches.sort((a, b) => a.localeCompare(b)),
    allMorphTargetNames,
  };
}

export async function loadAndCheckAvatarCompatibility(
  modelUrl: string,
): Promise<CheckResult> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = (await loader.loadAsync(modelUrl)) as LoadedGltf;
  return checkAvatarCompatibility(gltf);
}

export function logAvatarCompatibility(result: CheckResult): void {
  console.group("Avatar compatibility check");
  console.log("Meshes:", result.meshCount);
  console.log("Meshes with morph targets:", result.morphMeshCount);
  console.log("Head-like bones/nodes:", result.headLikeBones);
  console.log(
    "ARKit-compatible blendshape matches:",
    result.arkitMatches.length,
  );
  console.log("Matched ARKit names:", result.arkitMatches);
  console.log("All morph target names:", result.allMorphTargetNames);

  if (result.morphMeshCount === 0) {
    console.warn(
      "No morph targets found: this model will not show facial expressions in Aniface.",
    );
  } else if (result.arkitMatches.length === 0) {
    console.warn(
      "Morph targets exist, but none match common ARKit names. You may need name remapping.",
    );
  } else {
    console.info("This model looks promising for facial expression retargeting.");
  }

  if (result.headLikeBones.length === 0) {
    console.warn(
      "No obvious head/neck/jaw bones found. Head rotation tracking may need manual rig inspection.",
    );
  }

  console.groupEnd();
}

export async function checkAllAvatars() {
  for (const model of modelOptions) {
    const result = await loadAndCheckAvatarCompatibility(model.model);
    console.log(model.name);
    logAvatarCompatibility(result);
    console.log();
    console.log();
  }
}
