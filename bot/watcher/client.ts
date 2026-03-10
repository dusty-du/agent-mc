import TWEEN from "@tweenjs/tween.js";
import { io } from "socket.io-client";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Viewer } from "prismarine-viewer/viewer";
import type { ResidentPresentationState } from "@resident/shared";
import { resolveStickyVisibility } from "../src/thought-bubble-visibility";

type BotPosition = {
  x: number;
  y: number;
  z: number;
};

type PositionPacket = {
  entityId?: number;
  pos: BotPosition;
  yaw?: number;
  pitch?: number;
  addMesh?: boolean;
};

const DEFAULT_LOOK_TARGET_OFFSET_Y = 1.62;
const DEFAULT_BUBBLE_OFFSET_Y = 2.15;
const BUBBLE_CLEARANCE_Y = 0.35;
const LOOK_TARGET_TOP_INSET_Y = 0.18;
const MIN_LOCK_HEIGHT = 2.5;
const MAX_LOCK_HEIGHT = 10;
const MIN_LOCK_DISTANCE = 6;
const MAX_LOCK_DISTANCE = 18;
const DEFAULT_LOCK_OFFSET = new THREE.Vector3(7.5, 5.5, 7.5);
const CAMERA_COLLISION_PADDING = 0.4;
const MIN_CAMERA_DISTANCE = 1.75;
const OCCLUSION_EPSILON = 0.05;
const THOUGHT_BUBBLE_SCREEN_MARGIN = 18;
const THOUGHT_BUBBLE_OFFSCREEN_GRACE_MS = 800;

const root = document.body;
const thoughtBubble = document.getElementById("thought-bubble") as HTMLDivElement;
const headLockButton = document.getElementById("head-lock-button") as HTMLButtonElement;

(globalThis as { THREE?: typeof THREE }).THREE = THREE;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
root.prepend(renderer.domElement);

const viewer = new Viewer(renderer as never);
const controls = new OrbitControls(viewer.camera as THREE.PerspectiveCamera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = true;
controls.target.set(0, DEFAULT_LOOK_TARGET_OFFSET_Y, 0);

const socket = io({ path: "/socket.io" });

let firstPositionUpdate = true;
let botLookTargetOffsetY = DEFAULT_LOOK_TARGET_OFFSET_Y;
let botBubbleOffsetY = DEFAULT_BUBBLE_OFFSET_Y;
let latestPosition: BotPosition | undefined;
let latestYaw = 0;
let latestPresentation: ResidentPresentationState = { thought: null };
let headLock = false;
let lockedOffset = DEFAULT_LOCK_OFFSET.clone();
let selfEntityId: string | undefined;
let bubbleHiddenSinceMs: number | null = null;
let lastBubbleScreenPosition: { x: number; y: number } | undefined;
const sceneRaycaster = new THREE.Raycaster();

window.addEventListener("resize", () => {
  const camera = viewer.camera as THREE.PerspectiveCamera;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateThoughtBubble();
});

headLockButton.addEventListener("click", () => {
  setHeadLock(!headLock);
});

function animate(): void {
  window.requestAnimationFrame(animate);
  if (!headLock) {
    controls.update();
  }
  TWEEN.update();
  viewer.update();
  if (headLock) {
    syncLockedCamera();
  }
  updateThoughtBubble();
  renderer.render(viewer.scene, viewer.camera);
}
animate();

socket.on("version", (version: string) => {
  if (!viewer.setVersion(version)) {
    return;
  }

  firstPositionUpdate = true;
  viewer.listen(socket);
});

socket.on("presentation", (state: ResidentPresentationState) => {
  latestPresentation = state;
  updateThoughtBubble();
});

socket.on("position", ({ entityId, pos, yaw = 0, pitch }: PositionPacket) => {
  latestPosition = pos;
  latestYaw = yaw;
  selfEntityId = entityId !== undefined ? String(entityId) : selfEntityId;

  if (pitch !== undefined) {
    viewer.setFirstPersonCamera(pos as never, yaw, pitch);
    return;
  }

  const anchor = lookAnchor();
  if (firstPositionUpdate && anchor) {
    controls.target.copy(anchor);
    (viewer.camera as THREE.PerspectiveCamera).position.copy(resolveCameraPosition(anchor, DEFAULT_LOCK_OFFSET));
    controls.update();
    firstPositionUpdate = false;
  }

  if (headLock) {
    syncLockedCamera();
  }
});

function setHeadLock(nextState: boolean): void {
  headLock = nextState;
  controls.enabled = !headLock;
  headLockButton.classList.toggle("is-active", headLock);
  headLockButton.setAttribute("aria-pressed", String(headLock));

  if (headLock) {
    const anchor = lookAnchor();
    if (anchor) {
      const currentOffset = (viewer.camera as THREE.PerspectiveCamera).position.clone().sub(anchor);
      if (isUsableLockOffset(currentOffset)) {
        lockedOffset.copy(currentOffset);
      } else {
        lockedOffset.copy(DEFAULT_LOCK_OFFSET);
      }
      syncLockedCamera();
    }
  } else {
    const anchor = lookAnchor();
    if (anchor) {
      controls.target.copy(anchor);
    }
    controls.update();
  }
}

function syncLockedCamera(): void {
  const anchor = lookAnchor();
  if (!anchor) {
    return;
  }

  const camera = viewer.camera as THREE.PerspectiveCamera;
  camera.position.copy(resolveCameraPosition(anchor, lockedOffset));
  camera.lookAt(anchor);
}

function updateThoughtBubble(): void {
  const thought = latestPresentation.thought;
  const anchor = bubbleAnchor();
  const nowMs = Date.now();
  if (!thought || !anchor || Date.parse(thought.expiresAt) <= nowMs) {
    hideThoughtBubble();
    return;
  }

  const projected = anchor.clone().project(viewer.camera as THREE.PerspectiveCamera);
  const visibility = resolveStickyVisibility(
    projected.z <= 1 && projected.z >= -1,
    nowMs,
    bubbleHiddenSinceMs,
    THOUGHT_BUBBLE_OFFSCREEN_GRACE_MS
  );
  bubbleHiddenSinceMs = visibility.hiddenSinceMs;
  if (!visibility.visible) {
    hideThoughtBubble();
    return;
  }

  if (projected.z <= 1 && projected.z >= -1) {
    lastBubbleScreenPosition = {
      x: clamp((projected.x * 0.5 + 0.5) * window.innerWidth, THOUGHT_BUBBLE_SCREEN_MARGIN, window.innerWidth - THOUGHT_BUBBLE_SCREEN_MARGIN),
      y: clamp((-projected.y * 0.5 + 0.5) * window.innerHeight - 20, THOUGHT_BUBBLE_SCREEN_MARGIN, window.innerHeight - THOUGHT_BUBBLE_SCREEN_MARGIN)
    };
  }

  if (!lastBubbleScreenPosition) {
    hideThoughtBubble();
    return;
  }

  thoughtBubble.textContent = thought.text;
  thoughtBubble.style.left = `${lastBubbleScreenPosition.x}px`;
  thoughtBubble.style.top = `${lastBubbleScreenPosition.y}px`;
  thoughtBubble.classList.remove("is-hidden");
}

function hideThoughtBubble(): void {
  bubbleHiddenSinceMs = null;
  lastBubbleScreenPosition = undefined;
  thoughtBubble.classList.add("is-hidden");
}

function lookAnchor(): THREE.Vector3 | undefined {
  const selfMesh = currentSelfMesh();
  if (selfMesh) {
    calibrateSelfMeshAnchorOffsets(selfMesh);
  }
  if (latestPosition) {
    return new THREE.Vector3(latestPosition.x, latestPosition.y + botLookTargetOffsetY, latestPosition.z);
  }
  if (selfMesh) {
    return new THREE.Vector3(selfMesh.position.x, selfMesh.position.y + botLookTargetOffsetY, selfMesh.position.z);
  }
}

function bubbleAnchor(): THREE.Vector3 | undefined {
  const selfMesh = currentSelfMesh();
  if (selfMesh) {
    calibrateSelfMeshAnchorOffsets(selfMesh);
  }
  if (latestPosition) {
    return new THREE.Vector3(latestPosition.x, latestPosition.y + botBubbleOffsetY, latestPosition.z);
  }
  if (selfMesh) {
    return new THREE.Vector3(selfMesh.position.x, selfMesh.position.y + botBubbleOffsetY, selfMesh.position.z);
  }
}

function calibrateSelfMeshAnchorOffsets(selfMesh: THREE.Object3D): void {
  const bounds = new THREE.Box3().setFromObject(selfMesh);
  if (bounds.isEmpty()) {
    return;
  }

  const topOffset = bounds.max.y - selfMesh.position.y;
  if (topOffset <= 0) {
    return;
  }

  botLookTargetOffsetY = Math.max(DEFAULT_LOOK_TARGET_OFFSET_Y, topOffset - LOOK_TARGET_TOP_INSET_Y);
  botBubbleOffsetY = Math.max(DEFAULT_BUBBLE_OFFSET_Y, topOffset + BUBBLE_CLEARANCE_Y);
}

function isUsableLockOffset(offset: THREE.Vector3): boolean {
  return (
    offset.y >= MIN_LOCK_HEIGHT &&
    offset.y <= MAX_LOCK_HEIGHT &&
    offset.length() >= MIN_LOCK_DISTANCE &&
    offset.length() <= MAX_LOCK_DISTANCE
  );
}

function resolveCameraPosition(anchor: THREE.Vector3, desiredOffset: THREE.Vector3): THREE.Vector3 {
  const candidateOffsets = candidateCameraOffsets(desiredOffset);
  let bestBlockedPosition: THREE.Vector3 | undefined;
  let bestBlockedDistance = -Infinity;

  for (const candidateOffset of candidateOffsets) {
    const desiredPosition = anchor.clone().add(candidateOffset);
    const direction = desiredPosition.clone().sub(anchor);
    const obstruction = firstObstructionBetween(anchor, desiredPosition);
    if (!obstruction) {
      return desiredPosition;
    }

    const safeDistance = Math.max(MIN_CAMERA_DISTANCE, obstruction.distance - CAMERA_COLLISION_PADDING);
    if (safeDistance > bestBlockedDistance) {
      bestBlockedDistance = safeDistance;
      bestBlockedPosition = anchor.clone().add(direction.normalize().multiplyScalar(safeDistance));
    }
  }

  return bestBlockedPosition ?? anchor.clone().add(desiredOffset);
}

function firstObstructionBetween(start: THREE.Vector3, end: THREE.Vector3): THREE.Intersection | undefined {
  const direction = end.clone().sub(start);
  const distance = direction.length();
  if (distance <= OCCLUSION_EPSILON) {
    return undefined;
  }

  sceneRaycaster.set(start, direction.normalize());
  sceneRaycaster.far = distance;

  return sceneRaycaster
    .intersectObjects(collectIntersectableObjects(), false)
    .find(
      (intersection) =>
        intersection.distance > OCCLUSION_EPSILON &&
        !isBotMeshObject(intersection.object)
    );
}

function isBotMeshObject(object: THREE.Object3D | null): boolean {
  const selfMesh = currentSelfMesh();
  if (!selfMesh) {
    return false;
  }

  let current = object;
  while (current) {
    if (current === selfMesh) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function candidateCameraOffsets(desiredOffset: THREE.Vector3): THREE.Vector3[] {
  const baseOffset = desiredOffset.length() > 0 ? desiredOffset : yawRelativeDefaultOffset();
  const radius = Math.max(MIN_LOCK_DISTANCE, Math.hypot(baseOffset.x, baseOffset.z));
  const baseHeight = clamp(baseOffset.y || DEFAULT_LOCK_OFFSET.y, MIN_LOCK_HEIGHT, MAX_LOCK_HEIGHT);
  const desiredAngle = Math.atan2(baseOffset.z, baseOffset.x);
  const angleOffsets = [
    0,
    Math.PI / 4,
    -Math.PI / 4,
    Math.PI / 2,
    -Math.PI / 2,
    (3 * Math.PI) / 4,
    (-3 * Math.PI) / 4,
    Math.PI
  ];
  const heights = Array.from(new Set([
    baseHeight,
    clamp(baseHeight + 2, MIN_LOCK_HEIGHT, MAX_LOCK_HEIGHT),
    clamp(baseHeight + 4, MIN_LOCK_HEIGHT, MAX_LOCK_HEIGHT)
  ]));
  const offsets: THREE.Vector3[] = [];

  for (const height of heights) {
    for (const angleOffset of angleOffsets) {
      offsets.push(offsetFromAngle(desiredAngle + angleOffset, radius, height));
    }
  }

  const yawOffset = yawRelativeDefaultOffset();
  offsets.push(yawOffset);
  offsets.push(offsetFromAngle(latestYaw * (Math.PI / 180), radius, baseHeight));

  return dedupeOffsets([baseOffset, ...offsets]);
}

function yawRelativeDefaultOffset(): THREE.Vector3 {
  return rotateOffsetY(DEFAULT_LOCK_OFFSET, latestYaw);
}

function rotateOffsetY(offset: THREE.Vector3, angle: number): THREE.Vector3 {
  return offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
}

function offsetFromAngle(angle: number, radius: number, height: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
}

function dedupeOffsets(offsets: THREE.Vector3[]): THREE.Vector3[] {
  const seen = new Set<string>();
  const unique: THREE.Vector3[] = [];

  for (const offset of offsets) {
    const key = `${offset.x.toFixed(3)}:${offset.y.toFixed(3)}:${offset.z.toFixed(3)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(offset);
  }

  return unique;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function currentSelfMesh(): THREE.Object3D | undefined {
  if (!selfEntityId) {
    return undefined;
  }

  return ((viewer as unknown as { entities?: { entities?: Record<string, THREE.Object3D> } }).entities?.entities ?? {})[selfEntityId];
}

function collectIntersectableObjects(): THREE.Object3D[] {
  const objects: THREE.Object3D[] = [];
  viewer.scene.traverseVisible((object) => {
    if (object === viewer.scene || object.type === "Sprite" || isBotMeshObject(object)) {
      return;
    }
    if (typeof (object as { raycast?: unknown }).raycast === "function") {
      objects.push(object);
    }
  });
  return objects;
}

(globalThis as {
  __residentWatcher?: {
    getState: () => {
      selfEntityId?: string;
      latestPosition?: BotPosition;
      latestYaw: number;
      hasSelfMesh: boolean;
      selfMeshPosition?: { x: number; y: number; z: number };
      cameraPosition: { x: number; y: number; z: number };
      controlsTarget: { x: number; y: number; z: number };
    };
  };
}).__residentWatcher = {
  getState: () => {
    const selfMesh = currentSelfMesh();
    const camera = viewer.camera as THREE.PerspectiveCamera;
    return {
      selfEntityId,
      latestPosition,
      latestYaw,
      hasSelfMesh: Boolean(selfMesh),
      selfMeshPosition: selfMesh
        ? {
            x: selfMesh.position.x,
            y: selfMesh.position.y,
            z: selfMesh.position.z
          }
        : undefined,
      cameraPosition: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
      },
      controlsTarget: {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z
      }
    };
  }
};
