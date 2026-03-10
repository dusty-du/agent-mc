import TWEEN from "@tweenjs/tween.js";
import { io } from "socket.io-client";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Viewer, Entity } from "prismarine-viewer/viewer";
import { ResidentPresentationState } from "@resident/shared";

type BotPosition = {
  x: number;
  y: number;
  z: number;
};

type PositionPacket = {
  pos: BotPosition;
  yaw?: number;
  pitch?: number;
  addMesh?: boolean;
};

const HEAD_ANCHOR_Y = 2.6;
const MIN_LOCK_HEIGHT = 4;
const MIN_LOCK_DISTANCE = 8;
const DEFAULT_LOCK_OFFSET = new THREE.Vector3(8, 6, 8);

const root = document.body;
const thoughtBubble = document.getElementById("thought-bubble") as HTMLDivElement;
const headLockButton = document.getElementById("head-lock-button") as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
root.prepend(renderer.domElement);

const viewer = new Viewer(renderer as never);
const controls = new OrbitControls(viewer.camera as THREE.PerspectiveCamera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = true;
controls.target.set(0, HEAD_ANCHOR_Y, 0);

const socket = io({ path: "/socket.io" });

let firstPositionUpdate = true;
let viewerVersion = "1.21.4";
let botMesh: { position: THREE.Vector3; rotation: THREE.Euler } | undefined;
let latestPosition: BotPosition | undefined;
let latestPresentation: ResidentPresentationState = { thought: null };
let headLock = false;
let lockedOffset = DEFAULT_LOCK_OFFSET.clone();

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

  viewerVersion = version;
  firstPositionUpdate = true;
  viewer.listen(socket);
});

socket.on("presentation", (state: ResidentPresentationState) => {
  latestPresentation = state;
  updateThoughtBubble();
});

socket.on("position", ({ pos, addMesh, yaw = 0, pitch }: PositionPacket) => {
  latestPosition = pos;

  if (pitch !== undefined) {
    viewer.setFirstPersonCamera(pos as never, yaw, pitch);
    return;
  }

  const anchor = headAnchorFor(pos);
  if (firstPositionUpdate && pos.y > 0) {
    controls.target.copy(anchor);
    (viewer.camera as THREE.PerspectiveCamera).position.set(pos.x, pos.y + 20, pos.z + 20);
    controls.update();
    firstPositionUpdate = false;
  }

  if (addMesh) {
    if (!botMesh) {
      botMesh = new Entity(viewerVersion, "player", viewer.scene as never).mesh;
      viewer.scene.add(botMesh as never);
    }
    new TWEEN.Tween(botMesh.position).to({ x: pos.x, y: pos.y, z: pos.z }, 50).start();

    const deltaAngle = (yaw - botMesh.rotation.y) % (Math.PI * 2);
    const shortestTurn = (2 * deltaAngle) % (Math.PI * 2) - deltaAngle;
    new TWEEN.Tween(botMesh.rotation).to({ y: botMesh.rotation.y + shortestTurn }, 50).start();
  }

  if (headLock) {
    syncLockedCamera();
  }
});

function setHeadLock(nextState: boolean): void {
  headLock = nextState;
  headLockButton.classList.toggle("is-active", headLock);
  headLockButton.setAttribute("aria-pressed", String(headLock));

  if (headLock) {
    if (latestPosition) {
      const currentOffset = (viewer.camera as THREE.PerspectiveCamera).position.clone().sub(headAnchorFor(latestPosition));
      if (currentOffset.y >= MIN_LOCK_HEIGHT && currentOffset.length() >= MIN_LOCK_DISTANCE) {
        lockedOffset.copy(currentOffset);
      } else {
        lockedOffset.copy(DEFAULT_LOCK_OFFSET);
      }
      syncLockedCamera();
    }
  } else if (latestPosition) {
    controls.target.copy(headAnchorFor(latestPosition));
    controls.update();
  }
}

function syncLockedCamera(): void {
  if (!latestPosition) {
    return;
  }

  const anchor = headAnchorFor(latestPosition);
  const camera = viewer.camera as THREE.PerspectiveCamera;
  camera.position.copy(anchor.clone().add(lockedOffset));
  camera.lookAt(anchor);
}

function updateThoughtBubble(): void {
  const thought = latestPresentation.thought;
  if (!thought || !latestPosition || Date.parse(thought.expiresAt) <= Date.now()) {
    thoughtBubble.classList.add("is-hidden");
    return;
  }

  const anchor = headAnchorFor(latestPosition);
  const projected = anchor.clone().project(viewer.camera as THREE.PerspectiveCamera);
  if (projected.z > 1 || projected.z < -1) {
    thoughtBubble.classList.add("is-hidden");
    return;
  }

  const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-projected.y * 0.5 + 0.5) * window.innerHeight - 20;
  thoughtBubble.textContent = thought.text;
  thoughtBubble.style.left = `${x}px`;
  thoughtBubble.style.top = `${y}px`;
  thoughtBubble.classList.remove("is-hidden");
}

function headAnchorFor(position: BotPosition): THREE.Vector3 {
  return new THREE.Vector3(position.x, position.y + HEAD_ANCHOR_Y, position.z);
}
