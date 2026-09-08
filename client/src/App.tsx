import { Canvas, useFrame } from "@react-three/fiber";
import { Sky, useGLTF, useAnimations, Html, OrbitControls } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

import { Ecctrl, type EcctrlHandle } from "ecctrl";

import { EcctrlCameraControls } from "ecctrl/camera";

import {
  Joystick,
  VirtualButton,
  useJoystickStore,
  useButtonStore,
} from "ecctrl/input";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import * as THREE from "three";

// ============================================================
// TYPES
// ============================================================

type AnimationName = "Idle" | "Walk" | "Run" | "Jump" | "RunJump";

type CharacterChoice = "isko" | "iska";

export type DeviceType = "desktop" | "mobile";

type PlayerRotation = {
  y: number;
};

type PlayerState = {
  id: string;
  name?: string;
  character?: CharacterChoice;
  location?: string;
  device?: DeviceType;
  position: { x: number; y: number; z: number };
  rotation?: PlayerRotation;
  animation?: AnimationName;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  character?: CharacterChoice;
  location?: string;
  device?: DeviceType;
  text: string;
  timestamp: number;
  isSystem?: boolean;
};

type MultiplayerSocket = Socket<
  {
    session: (session: { id: string; player?: PlayerState }) => void;
    players: (players: PlayerState[]) => void;
    "player:joined": (player: PlayerState) => void;
    "player:moved": (player: PlayerState) => void;
    "player:updated": (player: PlayerState) => void;
    "player:left": (data: { id: string }) => void;
    "chat:message": (msg: ChatMessage) => void;
    "chat:history": (history: ChatMessage[]) => void;
  },
  {
    "player:move": (data: {
      position: PlayerState["position"];
      rotation?: PlayerRotation;
      animation?: AnimationName;
      character?: CharacterChoice;
      location?: string;
      device?: DeviceType;
    }) => void;
    "player:customize": (data: {
      name?: string;
      character?: CharacterChoice;
      location?: string;
      device?: DeviceType;
    }) => void;
    "chat:send": (data: { text: string; device?: DeviceType }) => void;
  }
>;

// ============================================================
// CONSTANTS
// ============================================================

// Joystick run thresholds.
//
// Start running when joystick reaches 75%.
// Stop running when joystick falls below 45%.
//
// Having two different values prevents Walk/Run flickering.
const RUN_START_THRESHOLD = 0.75;
const RUN_STOP_THRESHOLD = 0.45;

// Movement deadzone
const JOYSTICK_DEADZONE = 0.12;

// ============================================================
// KEYBOARD
// ============================================================

function useKeyboard() {
  const keys = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      keys.current.add(event.key.toLowerCase());
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        keys.current.clear();
        return;
      }
      keys.current.delete(event.key.toLowerCase());
    };

    window.addEventListener("keydown", handleKeyDown);

    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);

      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  return keys;
}

// ============================================================
// CHARACTER MODELS (ISKO & ISKA)
// ============================================================

function IskoModel({ animation }: { animation: AnimationName }) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF("/models/player.glb");
  const modelClone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    if (!actions) return;
    const actionNames = Object.keys(actions);
    if (actionNames.length === 0) return;

    const lower = animation.toLowerCase();
    const actionName =
      actionNames.find((n) => n.toLowerCase() === lower) ||
      actionNames.find((n) => n.toLowerCase().includes(lower)) ||
      actionNames[0];

    const action = actionName ? actions[actionName] : null;
    if (!action) return;

    action.reset().fadeIn(0.2).play();
    return () => {
      action.fadeOut(0.2);
    };
  }, [actions, animation]);

  return (
    <group ref={group}>
      <primitive object={modelClone} scale={1} position={[0, -0.8, 0]} />
    </group>
  );
}

function IskaModel({ animation }: { animation: AnimationName }) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF("/models/iska.glb");
  const modelClone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    if (!actions) return;
    const actionNames = Object.keys(actions);
    if (actionNames.length === 0) return;

    const lower = animation.toLowerCase();
    const actionName =
      actionNames.find((n) => n.toLowerCase() === lower) ||
      actionNames.find((n) => n.toLowerCase().includes(lower)) ||
      actionNames[0];

    const action = actionName ? actions[actionName] : null;
    if (!action) return;

    action.reset().fadeIn(0.2).play();
    return () => {
      action.fadeOut(0.2);
    };
  }, [actions, animation]);

  return (
    <group ref={group}>
      <primitive object={modelClone} scale={1.45} position={[0, -0.8, 0]} />
    </group>
  );
}

function CharacterModel({
  animation,
  character = "isko",
}: {
  animation: AnimationName;
  character?: CharacterChoice;
}) {
  if (character === "iska") {
    return <IskaModel animation={animation} />;
  }
  return <IskoModel animation={animation} />;
}

// ============================================================
// PLAYER
// ============================================================

function Player({
  ecctrl,
  character = "isko",
  name = "Isko",
  chatBubble,
  onAnimationChange,
  canControl = true,
}: {
  ecctrl: React.RefObject<EcctrlHandle | null>;
  character?: CharacterChoice;
  name?: string;
  chatBubble?: string | null;
  onAnimationChange?: (animation: AnimationName) => void;
  canControl?: boolean;
}) {
  const keys = useKeyboard();

  const [animation, setAnimation] =
    useState<AnimationName>("Idle");

  const previousAnimation =
    useRef<AnimationName>("Idle");

  // ----------------------------------------------------------
  // Joystick run state
  // ----------------------------------------------------------

  const joystickRunning =
    useRef(false);

  // ----------------------------------------------------------
  // Remember whether the player was running
  // when the jump started.
  //
  // This is important because during the jump,
  // controller.isMoving may not reliably tell us
  // that the player was running.
  // ----------------------------------------------------------

  const jumpWasRunning =
    useRef(false);

  // ----------------------------------------------------------
  // JOYSTICK
  // ----------------------------------------------------------

  const joystick =
    useJoystickStore(
      (state) =>
        state.joysticks["default"]
    );

  // ----------------------------------------------------------
  // JUMP BUTTON
  // ----------------------------------------------------------

  const jumpButton =
    useButtonStore(
      (state) =>
        state.buttons["jump"] ?? false
    );

  // ----------------------------------------------------------
  // UPDATE
  // ----------------------------------------------------------

  useFrame(() => {
    const controller =
      ecctrl.current;

    if (!controller) return;

    if (!canControl) {
      controller.setMovement({
        forward: false,
        backward: false,
        leftward: false,
        rightward: false,
        run: false,
        jump: false,
      });
      if (previousAnimation.current !== "Idle") {
        previousAnimation.current = "Idle";
        setAnimation("Idle");
        onAnimationChange?.("Idle");
      }
      return;
    }

    // ========================================================
    // KEYBOARD
    // ========================================================

    const keyboardForward =
      keys.current.has("w");

    const keyboardBackward =
      keys.current.has("s");

    const keyboardLeft =
      keys.current.has("a");

    const keyboardRight =
      keys.current.has("d");

    const keyboardRun =
      keys.current.has("shift");

    const keyboardJump =
      keys.current.has(" ");

    // ========================================================
    // JOYSTICK VALUES
    // ========================================================

    const joystickX =
      joystick?.x ?? 0;

    const joystickY =
      joystick?.y ?? 0;

    const joystickMagnitude =
      Math.min(
        1,
        Math.sqrt(
          joystickX * joystickX +
          joystickY * joystickY
        )
      );

    // ========================================================
    // JOYSTICK MOVEMENT
    // ========================================================

    const joystickForward =
      joystickY > JOYSTICK_DEADZONE;

    const joystickBackward =
      joystickY < -JOYSTICK_DEADZONE;

    const joystickLeft =
      joystickX < -JOYSTICK_DEADZONE;

    const joystickRight =
      joystickX > JOYSTICK_DEADZONE;

    const joystickActive =
      joystick?.active === true &&
      joystickMagnitude >
      JOYSTICK_DEADZONE;

    // ========================================================
    // JOYSTICK RUN
    // ========================================================

    if (joystickActive) {
      // Start run
      if (
        !joystickRunning.current &&
        joystickMagnitude >=
        RUN_START_THRESHOLD
      ) {
        joystickRunning.current = true;
      }

      // Stop run
      if (
        joystickRunning.current &&
        joystickMagnitude <=
        RUN_STOP_THRESHOLD
      ) {
        joystickRunning.current = false;
      }
    } else {
      joystickRunning.current = false;
    }

    // ========================================================
    // FINAL MOVEMENT
    // ========================================================

    const forward =
      keyboardForward ||
      joystickForward;

    const backward =
      keyboardBackward ||
      joystickBackward;

    const leftward =
      keyboardLeft ||
      joystickLeft;

    const rightward =
      keyboardRight ||
      joystickRight;

    // ========================================================
    // RUN
    // ========================================================

    const run =
      keyboardRun ||
      joystickRunning.current;

    // ========================================================
    // JUMP
    // ========================================================

    const jump =
      keyboardJump ||
      jumpButton;

    // ========================================================
    // REMEMBER RUNNING WHEN JUMP STARTS
    // ========================================================

    if (
      controller.isOnGround &&
      jump &&
      controller.isMoving &&
      run
    ) {
      jumpWasRunning.current = true;
    }

    // ========================================================
    // RESET RUN-JUMP STATE
    //
    // Once the player lands, clear the stored state.
    // ========================================================

    if (
      controller.isOnGround &&
      !jump
    ) {
      jumpWasRunning.current = false;
    }

    // ========================================================
    // SEND INPUT TO ECCTRL
    // ========================================================

    controller.setMovement({
      forward,
      backward,
      leftward,
      rightward,
      run,
      jump,
    });

    // ========================================================
    // ANIMATION
    // ========================================================

    let nextAnimation:
      AnimationName = "Idle";

    // --------------------------------------------------------
    // AIRBORNE
    // --------------------------------------------------------

    if (!controller.isOnGround) {

      if (jumpWasRunning.current) {
        nextAnimation = "RunJump";
      } else {
        nextAnimation = "Jump";
      }

    }

    // --------------------------------------------------------
    // GROUND
    // --------------------------------------------------------

    else if (
      controller.isMoving &&
      run
    ) {
      nextAnimation = "Run";
    }

    else if (
      controller.isMoving
    ) {
      nextAnimation = "Walk";
    }

    else {
      nextAnimation = "Idle";
    }

    // ========================================================
    // CHANGE ANIMATION ONLY WHEN NEEDED
    // ========================================================

    if (
      previousAnimation.current !==
      nextAnimation
    ) {
      previousAnimation.current =
        nextAnimation;

      setAnimation(nextAnimation);
      onAnimationChange?.(nextAnimation);
    }
  });

  return (
    <Ecctrl
      ref={ecctrl}

      capsuleRadius={0.3}
      capsuleHalfHeight={0.3}

      maxWalkVel={2}
      maxRunVel={5}

      jumpVel={5}

      enableToggleRun={false}

      floatHeight={0.2}

      fallingGravityScale={3}
      fallingMaxVel={20}

      autoBalance={true}

      debug={false}
    >
      <CharacterModel
        animation={animation}
        character={character}
      />

      <Html position={[0, 1.4, 0]} center distanceFactor={12}>
        <div className={`player-badge player-badge-${character}`}>
          <span className="player-badge-dot" />
          <span className="player-badge-name">{name}</span>
        </div>
      </Html>

      {chatBubble && (
        <Html position={[0, 2.0, 0]} center distanceFactor={14}>
          <div className="chat-speech-bubble">
            {chatBubble}
          </div>
        </Html>
      )}
    </Ecctrl>
  );
}

// ============================================================
// REMOTE PLAYER
// ============================================================

function RemotePlayer({
  player,
  chatBubble,
}: {
  player: PlayerState;
  chatBubble?: string | null;
}) {
  const group = useRef<THREE.Group>(null);
  const targetPos = useRef(
    new THREE.Vector3(player.position.x, player.position.y, player.position.z),
  );
  const targetRotY = useRef(player.rotation?.y ?? 0);

  useEffect(() => {
    targetPos.current.set(
      player.position.x,
      player.position.y,
      player.position.z,
    );
    if (player.rotation?.y !== undefined) {
      targetRotY.current = player.rotation.y;
    }
  }, [player.position.x, player.position.y, player.position.z, player.rotation?.y]);

  useFrame((_, delta) => {
    if (!group.current) return;

    const posLerp = Math.min(1, delta * 15);
    group.current.position.lerp(targetPos.current, posLerp);

    const currentY = group.current.rotation.y;
    let diff = (targetRotY.current - currentY) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y += diff * posLerp;
  });

  const charType = player.character || "isko";

  return (
    <group
      ref={group}
      position={[player.position.x, player.position.y, player.position.z]}
    >
      <CharacterModel
        animation={player.animation || "Idle"}
        character={charType}
      />

      <Html position={[0, 1.4, 0]} center distanceFactor={12}>
        <div className={`player-badge player-badge-${charType}`}>
          <span className="player-badge-dot" />
          <span className="player-badge-name">{player.name || `${charType === "iska" ? "Iska" : "Isko"} #${player.id.slice(0, 4)}`}</span>
        </div>
      </Html>

      {chatBubble && (
        <Html position={[0, 2.0, 0]} center distanceFactor={14}>
          <div className="chat-speech-bubble">
            {chatBubble}
          </div>
        </Html>
      )}
    </group>
  );
}

// ============================================================
// CAMERA
// ============================================================

function PlayerCamera({
  target,
}: {
  target: React.RefObject<EcctrlHandle | null>;
}) {
  const cameraControls = useRef<any>(null);

  useFrame(() => {
    const player = target.current;
    const controls = cameraControls.current;

    if (!player || !controls) {
      return;
    }

    const pos = player.currPos;

    // Only move the camera target.
    // This keeps camera rotation controlled by the user.
    controls.moveTo(
      pos.x,
      pos.y + 1.5,
      pos.z,
      true
    );
  });

  return (
    <EcctrlCameraControls
      ref={cameraControls}
      makeDefault
      smoothTime={0.1}

      // =====================================================
      // CAMERA VERTICAL ROTATION LIMIT
      // =====================================================

      // Minimum vertical angle.
      // Prevents looking too far DOWN.
      minPolarAngle={Math.PI * 0.35}

      // Maximum vertical angle.
      // Prevents looking too far UP.
      maxPolarAngle={Math.PI * 0.65}

      // =====================================================
      // CAMERA ZOOM LIMIT
      // =====================================================

      minDistance={3}
      maxDistance={10}
    />
  );
}

// ============================================================
// INTRO ORBIT CAMERA
// ============================================================

function IntroCamera() {
  return (
    <OrbitControls
      makeDefault
      autoRotate
      autoRotateSpeed={1.0}
      enableDamping
      dampingFactor={0.06}
      minDistance={6}
      maxDistance={26}
      minPolarAngle={Math.PI * 0.2}
      maxPolarAngle={Math.PI * 0.47}
      target={[0, 1.2, 0]}
      enablePan={false}
    />
  );
}

// ============================================================
// TRANSITION CAMERA (SWOOP FROM ORBIT TO THIRD PERSON)
// ============================================================

function TransitionCamera({
  target,
  onComplete,
}: {
  target: React.RefObject<EcctrlHandle | null>;
  onComplete: () => void;
}) {
  const startPos = useRef<THREE.Vector3 | null>(null);
  const startLookAt = useRef<THREE.Vector3 | null>(null);
  const elapsed = useRef(0);
  const DURATION = 1.2;

  useFrame((state, delta) => {
    const player = target.current;
    const playerPos = player?.currPos || new THREE.Vector3(0, 0, 0);

    if (!startPos.current || !startLookAt.current) {
      startPos.current = state.camera.position.clone();
      startLookAt.current = new THREE.Vector3(0, 1.2, 0);
    }

    const fromPos = startPos.current;
    const fromLookAt = startLookAt.current;

    elapsed.current += delta;
    const t = Math.min(1, elapsed.current / DURATION);
    // Smooth easeInOutCubic
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const endPos = new THREE.Vector3(
      playerPos.x,
      playerPos.y + 2.5,
      playerPos.z + 5.5,
    );
    const endLookAt = new THREE.Vector3(
      playerPos.x,
      playerPos.y + 1.3,
      playerPos.z,
    );

    state.camera.position.lerpVectors(fromPos, endPos, ease);
    const look = new THREE.Vector3().lerpVectors(
      fromLookAt,
      endLookAt,
      ease,
    );
    state.camera.lookAt(look);

    if (t >= 1) {
      onComplete();
    }
  });

  return null;
}

// ============================================================
// MOBILE CONTROLS
// ============================================================

function MobileControls() {
  const isMobile = useIsMobile();

  if (!isMobile) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,

        pointerEvents: "none",

        zIndex: 100,

        userSelect: "none",

        touchAction: "none",
      }}
    >
      {/* =====================================================
          JOYSTICK
          ===================================================== */}

      <Joystick
        id="default"
        joystickMaxRadius={55}
        joystickWrapperStyle={{
          position: "absolute",

          left: "30px",

          bottom: "30px",

          width: "150px",

          height: "150px",

          borderRadius: "50%",

          background: "rgba(0, 0, 0, 0.25)",

          border: "2px solid rgba(255,255,255,0.25)",

          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          pointerEvents: "auto",

          touchAction: "none",
        }}
        joystickBaseStyle={{
          width: "100px",

          height: "100px",

          borderRadius: "50%",

          background: "rgba(255,255,255,0.15)",

          border: "2px solid rgba(255,255,255,0.25)",

          display: "flex",

          alignItems: "center",

          justifyContent: "center",
        }}
        joystickKnobStyle={{
          width: "60px",

          height: "60px",

          borderRadius: "50%",

          background: "rgba(255,255,255,0.65)",

          border: "2px solid rgba(255,255,255,0.8)",
        }}
      />

      {/* =====================================================
          JUMP BUTTON
          ===================================================== */}

      <VirtualButton
        id="jump"
        label="JUMP"
        buttonWrapperStyle={{
          position: "absolute",

          right: "35px",

          bottom: "45px",

          width: "85px",

          height: "85px",

          borderRadius: "50%",

          background: "rgba(0, 0, 0, 0.25)",

          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          pointerEvents: "auto",

          touchAction: "none",
        }}
        buttonCapStyle={{
          width: "65px",

          height: "65px",

          borderRadius: "50%",

          background: "rgba(255,255,255,0.65)",

          color: "#222",

          fontWeight: "bold",

          fontSize: "12px",

          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          border: "2px solid rgba(255,255,255,0.8)",
        }}
      />
    </div>
  );
}

// ============================================================
// GROUND
// ============================================================

function Ground() {
  return (
    <RigidBody type="fixed" colliders={false}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />

        <meshStandardMaterial color="#777777" />
      </mesh>

      <CuboidCollider args={[50, 0.1, 50]} position={[0, -0.1, 0]} />
    </RigidBody>
  );
}

// ============================================================
// STATIC BOX
// ============================================================

function Box({
  position,
  scale = [1, 1, 1],
}: {
  position: [number, number, number];

  scale?: [number, number, number];
}) {
  return (
    <RigidBody type="fixed" colliders="cuboid" position={position}>
      <mesh scale={scale} castShadow receiveShadow>
        <boxGeometry />

        <meshStandardMaterial color="#555" />
      </mesh>
    </RigidBody>
  );
}

/**
 * Detect real device location using browser Geolocation API with GPS coordinates
 * and OpenStreetMap Nominatim reverse geocoding, with a seamless IP-based fallback.
 */
async function detectDeviceLocation(): Promise<string> {
  // 1) First attempt: High-accuracy browser Geolocation API
  try {
    const coords = await new Promise<GeolocationCoordinates>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos.coords),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }
      );
    });

    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${coords.latitude}&lon=${coords.longitude}&format=json&accept-language=en`,
      { headers: { "User-Agent": "Iskolia3DCampus/1.0" } }
    );

    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      const city =
        addr.city ||
        addr.town ||
        addr.municipality ||
        addr.village ||
        addr.county ||
        "";
      const state = addr.state || addr.region || addr.province || "";
      const country = addr.country || "";

      const parts = [city, state, country].filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
    }
  } catch {
    // Geolocation denied, timed out, or unavailable
  }

  // 2) Fallback: IP-based geolocation (no permission dialog required)
  try {
    const ipRes = await fetch("https://ipwho.is/");
    if (ipRes.ok) {
      const ipData = await ipRes.json();
      if (ipData && ipData.success !== false) {
        const parts = [ipData.city, ipData.region, ipData.country].filter(Boolean);
        if (parts.length > 0) return parts.join(", ");
      }
    }
  } catch {
    // Fallback failed
  }

  return "";
}

/**
 * Detect whether the device is desktop or mobile phone
 */
function getDeviceType(): DeviceType {
  if (typeof window === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isSmall = window.innerWidth <= 768;
  return isMobileUA || (isTouch && isSmall) ? "mobile" : "desktop";
}

/**
 * Format location like "Calauag, PH" or "Lopez, PH"
 */
function formatLocationCityCountry(location?: string): string {
  if (!location) return "";
  const parts = location.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const city = parts[0];
  if (parts.length === 1) return city;

  const country = parts[parts.length - 1];
  let countryCode = country;
  const countryLower = country.toLowerCase();
  if (countryLower.includes("philippines")) {
    countryCode = "PH";
  } else if (countryLower.includes("united states") || countryLower === "usa") {
    countryCode = "US";
  } else if (countryLower.includes("united kingdom") || countryLower === "uk") {
    countryCode = "UK";
  } else if (countryLower.includes("japan")) {
    countryCode = "JP";
  } else if (countryLower.includes("canada")) {
    countryCode = "CA";
  } else if (countryLower.includes("australia")) {
    countryCode = "AU";
  } else if (countryLower.includes("singapore")) {
    countryCode = "SG";
  } else if (country.length > 2) {
    countryCode = country.slice(0, 2).toUpperCase();
  }

  return `${city}, ${countryCode}`;
}

/**
 * Format relative time (e.g. "19s ago", "just now", "2m ago")
 */
function formatTimeAgo(timestamp: number, now: number): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function RemotePlayers({
  players,
  ownId,
  chatBubbles,
}: {
  players: Map<string, PlayerState>;
  ownId: string | null;
  chatBubbles: Map<string, { text: string; expiresAt: number }>;
}) {
  return Array.from(players.values())
    .filter((player) => player.id !== ownId)
    .map((player) => (
      <RemotePlayer
        key={player.id}
        player={player}
        chatBubble={chatBubbles.get(player.id)?.text}
      />
    ));
}

function MultiplayerSync({
  socket,
  ecctrl,
  character,
  location,
  currentAnimation,
}: {
  socket: MultiplayerSocket | null;
  ecctrl: React.RefObject<EcctrlHandle | null>;
  character: CharacterChoice;
  location?: string;
  currentAnimation: React.RefObject<AnimationName>;
}) {
  const lastSentAt = useRef(0);
  const lastPos = useRef(new THREE.Vector3());
  const lastRotY = useRef<number>(0);
  const lastAnim = useRef<AnimationName>("Idle");
  const lastChar = useRef<CharacterChoice>(character);
  const lastLoc = useRef<string | undefined>(location);

  useFrame((_, delta) => {
    if (!socket?.connected || !ecctrl.current) return;

    lastSentAt.current += delta * 1000;
    if (lastSentAt.current < 45) return;

    const position = ecctrl.current.currPos;
    const quat = ecctrl.current.currQuat;
    if (!position || !quat) return;

    const euler = new THREE.Euler().setFromQuaternion(quat, "YXZ");
    const rotY = euler.y;
    const anim = currentAnimation.current;

    const distMoved = position.distanceTo(lastPos.current);
    const rotDiff = Math.abs(rotY - lastRotY.current);
    const animChanged = anim !== lastAnim.current;
    const charChanged = character !== lastChar.current;
    const locChanged = location !== lastLoc.current;

    if (
      distMoved > 0.005 ||
      rotDiff > 0.015 ||
      animChanged ||
      charChanged ||
      locChanged ||
      lastSentAt.current >= 500
    ) {
      lastSentAt.current = 0;
      lastPos.current.copy(position);
      lastRotY.current = rotY;
      lastAnim.current = anim;
      lastChar.current = character;
      lastLoc.current = location;

      socket.emit("player:move", {
        position: {
          x: Number(position.x.toFixed(3)),
          y: Number(position.y.toFixed(3)),
          z: Number(position.z.toFixed(3)),
        },
        rotation: {
          y: Number(rotY.toFixed(3)),
        },
        animation: anim,
        character: character,
        location: location,
        device: getDeviceType(),
      });
    }
  });

  return null;
}

// ============================================================
// WORLD
// ============================================================

function Stairs() {
  const stepCount = 20;

  const stepWidth = 4;
  const stepDepth = 0.6;
  const stepHeight = 0.3;

  return (
    <group position={[6, 0, -2]}>
      {Array.from({ length: stepCount }).map((_, index) => {
        const height = stepHeight * (index + 1);

        return (
          <RigidBody
            key={index}
            type="fixed"
            colliders="cuboid"
            position={[
              0,
              height / 2,
              index * stepDepth,
            ]}
          >
            <mesh
              castShadow
              receiveShadow
              scale={[
                stepWidth,
                height,
                stepDepth,
              ]}
            >
              <boxGeometry />
              <meshStandardMaterial color="#888888" />
            </mesh>
          </RigidBody>
        );
      })}
    </group>
  );
}

function World() {
  return (
    <>
      {/* SKY */}

      <Sky
        sunPosition={[
          100,
          20,
          100,
        ]}
      />

      {/* LIGHT */}

      <ambientLight
        intensity={1.3}
      />

      <directionalLight
        position={[
          10,
          20,
          10,
        ]}
        intensity={2}
        castShadow
      />

      {/* GROUND */}

      <Ground />

      {/* OBSTACLES */}

      <Box
        position={[
          3,
          1,
          0,
        ]}
        scale={[
          2,
          2,
          2,
        ]}
      />

      <Box
        position={[
          -3,
          1,
          -5,
        ]}
        scale={[
          2,
          2,
          2,
        ]}
      />

      <Box
        position={[
          0,
          1,
          -10,
        ]}
        scale={[
          6,
          2,
          1,
        ]}
      />

      {/* =====================================================
          STAIRS TEST
          ===================================================== */}

      <Stairs />
    </>
  );
}

// ============================================================
// APP
// ============================================================

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(
        window.matchMedia("(pointer: coarse)").matches ||
        "ontouchstart" in window ||
        navigator.maxTouchPoints > 0,
      );
    };

    checkMobile();

    window.addEventListener("resize", checkMobile);

    return () => {
      window.removeEventListener("resize", checkMobile);
    };
  }, []);

  return isMobile;
}

function useMultiplayer() {
  const [players, setPlayers] = useState<Map<string, PlayerState>>(new Map());
  const [ownId, setOwnId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatBubbles, setChatBubbles] = useState<
    Map<string, { text: string; expiresAt: number }>
  >(new Map());
  const socketRef = useRef<MultiplayerSocket | null>(null);

  useEffect(() => {
    const serverUrl =
      import.meta.env.VITE_MULTIPLAYER_URL ||
      import.meta.env.VITE_SERVER_URL ||
      "http://localhost:3001";

    const socket = io(serverUrl, {
      autoConnect: true,
    }) as MultiplayerSocket;
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setOwnId(null);
      setPlayers(new Map());
    });
    socket.on("session", ({ id }) => setOwnId(id));
    socket.on("players", (nextPlayers) => {
      setPlayers(new Map(nextPlayers.map((player) => [player.id, player])));
    });
    socket.on("player:joined", (player) => {
      setPlayers((current) => {
        const next = new Map(current);
        next.set(player.id, player);
        return next;
      });
    });
    socket.on("player:moved", (player) => {
      setPlayers((current) => {
        const next = new Map(current);
        next.set(player.id, player);
        return next;
      });
    });
    socket.on("player:updated", (player) => {
      setPlayers((current) => {
        const next = new Map(current);
        next.set(player.id, player);
        return next;
      });
    });
    socket.on("player:left", ({ id }) => {
      setPlayers((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    });

    socket.on("chat:history", (history) => {
      setMessages(history);
    });

    socket.on("chat:message", (msg) => {
      setMessages((prev) => [...prev.slice(-49), msg]);

      if (!msg.isSystem && msg.senderId) {
        const expiresAt = Date.now() + 6500;
        setChatBubbles((prev) => {
          const next = new Map(prev);
          next.set(msg.senderId, { text: msg.text, expiresAt });
          return next;
        });

        setTimeout(() => {
          setChatBubbles((prev) => {
            const current = prev.get(msg.senderId);
            if (current && current.expiresAt <= Date.now() + 100) {
              const next = new Map(prev);
              next.delete(msg.senderId);
              return next;
            }
            return prev;
          });
        }, 6600);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const customizePlayer = (
    name: string,
    character: CharacterChoice,
    location?: string,
    device?: DeviceType
  ) => {
    socketRef.current?.emit("player:customize", {
      name,
      character,
      location,
      device: device || getDeviceType(),
    });
  };

  const sendMessage = (text: string) => {
    socketRef.current?.emit("chat:send", {
      text,
      device: getDeviceType(),
    });
  };

  return {
    connected,
    ownId,
    players,
    messages,
    chatBubbles,
    socketRef,
    customizePlayer,
    sendMessage,
  };
}

// ============================================================
// STARTING INTRO SCREEN
// ============================================================

type GamePhase = "intro" | "transitioning" | "playing";

function StartIntroScreen({
  character,
  name,
  onSelectCharacter,
  onNameChange,
  onEnter,
  onlineCount,
  isConnected,
}: {
  character: CharacterChoice;
  name: string;
  onSelectCharacter: (char: CharacterChoice) => void;
  onNameChange: (name: string) => void;
  onEnter: () => void;
  onlineCount: number;
  isConnected: boolean;
}) {
  return (
    <div className="start-intro-overlay">
      <div className="start-intro-card">
        <div className="start-intro-header">
          <div className="start-intro-badge">
            <span className="badge-sparkle">✨</span>
            <span>ISKOLIA 3D CAMPUS</span>
          </div>
          <h1 className="start-intro-title">Welcome to Campus</h1>
          <p className="start-intro-subtitle">
            Choose your student avatar and enter the virtual university
          </p>
        </div>

        {/* CHARACTER SELECTION */}
        <div className="char-cards-container">
          <button
            type="button"
            className={`char-card ${character === "isko" ? "selected-isko" : ""}`}
            onClick={() => onSelectCharacter("isko")}
          >
            <div className="char-avatar-icon char-avatar-isko">👦</div>
            <span className="char-name">Isko</span>
            <span className="char-tag char-tag-isko">Male Student</span>
          </button>

          <button
            type="button"
            className={`char-card ${character === "iska" ? "selected-iska" : ""}`}
            onClick={() => onSelectCharacter("iska")}
          >
            <div className="char-avatar-icon char-avatar-iska">👧</div>
            <span className="char-name">Iska</span>
            <span className="char-tag char-tag-iska">Female Student</span>
          </button>
        </div>

        {/* DISPLAY NAME */}
        <div className="char-input-group">
          <label className="char-input-label">Student Name</label>
          <input
            type="text"
            maxLength={18}
            className="char-name-input"
            placeholder="Enter your student name..."
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onEnter();
              }
            }}
          />
        </div>

        {/* QUICK STATUS & CONTROLS GUIDE */}
        <div className="start-info-row">
          <div className="start-status-chip">
            <span className={isConnected ? "online-dot" : "offline-dot"} />
            <span>
              {isConnected ? `${onlineCount} Online` : "Connecting..."}
            </span>
          </div>
          <div className="start-controls-hints">
            <span>⌨️ WASD Move</span>
            <span>⚡ Shift Sprint</span>
            <span>🦘 Space Jump</span>
            <span>💬 Enter Chat</span>
          </div>
        </div>

        {/* CTA ENTER BUTTON */}
        <button
          type="button"
          className="btn-enter-world btn-enter-campus-glow"
          onClick={onEnter}
        >
          Enter Campus 🚀
        </button>
      </div>

      {/* BOTTOM ORBIT CAMERA HINT */}
      <div className="start-orbit-hint">
        <span className="orbit-dot-pulse" />
        <span>Cinematic Orbit Active • Drag anywhere on the screen to look around</span>
      </div>
    </div>
  );
}

// ============================================================
// ENTERING TRANSITION OVERLAY
// ============================================================

function EnteringOverlay({ playerName }: { playerName: string }) {
  return (
    <div className="entering-transition-overlay">
      <div className="entering-content">
        <div className="entering-spinner" />
        <h2 className="entering-title">Entering Campus...</h2>
        <p className="entering-name">Welcome, {playerName}!</p>
      </div>
    </div>
  );
}

// ============================================================
// EDIT PROFILE MODAL (IN-GAME)
// ============================================================

function EditProfileModal({
  isOpen,
  initialCharacter,
  initialName,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  initialCharacter: CharacterChoice;
  initialName: string;
  onClose: () => void;
  onSave: (character: CharacterChoice, name: string) => void;
}) {
  const [selected, setSelected] = useState<CharacterChoice>(initialCharacter);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    setSelected(initialCharacter);
    setName(initialName);
  }, [initialCharacter, initialName, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="char-modal-backdrop" onClick={onClose}>
      <div className="char-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="char-modal-header-row">
          <h2 className="char-modal-title">Student Profile</h2>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="char-modal-subtitle">Customize your avatar and display name</p>

        <div className="char-cards-container">
          <div
            className={`char-card ${selected === "isko" ? "selected-isko" : ""}`}
            onClick={() => setSelected("isko")}
          >
            <div className="char-avatar-icon char-avatar-isko">👦</div>
            <span className="char-name">Isko</span>
            <span className="char-tag char-tag-isko">Male Student</span>
          </div>

          <div
            className={`char-card ${selected === "iska" ? "selected-iska" : ""}`}
            onClick={() => setSelected("iska")}
          >
            <div className="char-avatar-icon char-avatar-iska">👧</div>
            <span className="char-name">Iska</span>
            <span className="char-tag char-tag-iska">Female Student</span>
          </div>
        </div>

        <div className="char-input-group">
          <label className="char-input-label">Display Name</label>
          <input
            type="text"
            maxLength={18}
            className="char-name-input"
            placeholder="Enter your name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="modal-buttons-row">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-enter-world"
            style={{ flex: 1 }}
            onClick={() => {
              onSave(
                selected,
                name.trim() || (selected === "iska" ? "Iska" : "Isko")
              );
              onClose();
            }}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CHAT BOX & AVATARS
// ============================================================

function DesktopIcon() {
  return (
    <svg
      width="13"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="chat-device-svg"
    >
      <rect x="2" y="2.5" width="12" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </svg>
  );
}

function MobileIcon() {
  return (
    <svg
      width="10"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="chat-device-svg"
    >
      <rect x="4" y="2" width="8" height="12" rx="2" />
      <circle cx="8" cy="11.5" r="0.65" fill="currentColor" />
    </svg>
  );
}

function AvatarSketch({ name, character }: { name: string; character?: string }) {
  let hash = 0;
  const str = name || character || "student";
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  const idx = Math.abs(hash) % 6;

  if (idx === 0) {
    // Ero: Girl with dark bangs & long hair
    return (
      <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
        <path d="M13 22c0 10 2 17 4 19M35 22c0 10-2 17-4 19" strokeWidth="2" stroke="#18181b" />
        <path d="M16 20c0 7 3.5 12 8 12s8-5 8-12" fill="#fff" />
        <path d="M14 18c3 3 8 4 10 4s7-1 10-4c-1-6-7-9-10-9s-9 3-10 9z" fill="#18181b" stroke="none" />
        <circle cx="20.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
        <circle cx="27.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
        <path d="M22.5 27c0.8 0.7 2.2 0.7 3 0" strokeWidth="1.2" />
        <path d="M15 47c0-6 4-10 9-10s9 4 9 10" fill="#f8fafc" />
        <path d="M19 37l2 4M29 37l-2 4" strokeWidth="1.2" />
      </svg>
    );
  }

  if (idx === 1) {
    // Gandara: Guy with round glasses & necktie
    return (
      <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
        <path d="M15 18c1.5-5 5.5-9 9-9s7.5 4 9 9c-2-1.5-4.5-2-7-1.5-3 0-5.5 1.5-11 1.5z" fill="#18181b" stroke="none" />
        <path d="M16 19c0 7 3.5 12 8 12s8-5 8-12" fill="#fff" />
        <rect x="18" y="20.5" width="4.5" height="3.5" rx="1" fill="#fff" strokeWidth="1.3" />
        <rect x="25.5" y="20.5" width="4.5" height="3.5" rx="1" fill="#fff" strokeWidth="1.3" />
        <path d="M22.5 22h3" strokeWidth="1.3" />
        <circle cx="20.2" cy="22.2" r="0.8" fill="#18181b" stroke="none" />
        <circle cx="27.7" cy="22.2" r="0.8" fill="#18181b" stroke="none" />
        <path d="M22 27.5c1 0.7 3 0.7 4 0" strokeWidth="1.2" />
        <path d="M14 47c1-7 4.5-10 10-10s9 3 10 10" fill="#f8fafc" />
        <path d="M20 37l4 5 4-5" fill="#fff" strokeWidth="1.2" />
        <path d="M23 42l1 5 1-5z" fill="#18181b" stroke="none" />
      </svg>
    );
  }

  if (idx === 2) {
    // Mj: Girl with top bun & gentle smile
    return (
      <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
        <circle cx="24" cy="9" r="4.5" fill="#18181b" stroke="none" />
        <path d="M15 19c0-5 4-8.5 9-8.5s9 3.5 9 8.5c-2-1.5-5.5-2-9-2s-7 0.5-9 2z" fill="#18181b" stroke="none" />
        <path d="M16 19c0 7 3.5 12 8 12s8-5 8-12" fill="#fff" />
        <path d="M15.5 21c0.7 3 0.7 6 0 8M32.5 21c-0.7 3-0.7 6 0 8" strokeWidth="1.2" />
        <path d="M19 22c0.8-0.8 2.2-0.8 3 0" strokeWidth="1.4" />
        <path d="M26 22c0.8-0.8 2.2-0.8 3 0" strokeWidth="1.4" />
        <path d="M22.5 27c0.8 0.7 2.2 0.7 3 0" strokeWidth="1.2" />
        <path d="M15 47c0-7 4-11 9-11s9 4 9 11" fill="#f8fafc" />
        <path d="M21 36c1.5 2 4.5 2 6 0" strokeWidth="1.2" />
      </svg>
    );
  }

  if (idx === 3) {
    // Hiii: Girl with wavy hair & cute pattern blouse
    return (
      <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
        <path d="M13 19c-1.5 4-2 10 0 16M35 19c1.5 4 2 10 0 16" strokeWidth="2.2" stroke="#18181b" />
        <path d="M16 19c0 7 3.5 12 8 12s8-5 8-12" fill="#fff" />
        <path d="M15 16.5c2.5-4 6.5-6.5 10.5-6.5s8 2.5 10 6.5c-3 0-6 2-8.5 3.5-3-2-6-3.5-12-3.5z" fill="#18181b" stroke="none" />
        <circle cx="20.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
        <circle cx="27.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
        <circle cx="18" cy="25.5" r="1.2" fill="#fda4af" stroke="none" opacity="0.8" />
        <circle cx="30" cy="25.5" r="1.2" fill="#fda4af" stroke="none" opacity="0.8" />
        <path d="M22.5 27c0.8 0.7 2.2 0.7 3 0" strokeWidth="1.2" />
        <path d="M14 47c0-6 4-10 10-10s10 4 10 10" fill="#f8fafc" />
        <path d="M19 40l2 2M27 40l2 2" strokeWidth="1.1" stroke="#94a3b8" />
      </svg>
    );
  }

  if (idx === 4) {
    // Hi Negga: Cool guy with sunglasses & styled hair
    return (
      <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
        <path d="M15 18c1-5 4.5-8.5 9.5-8.5s8.5 3.5 9.5 8.5c-2-1.5-4-2-6.5-0.5-2 1-3.5 1.5-5.5 0.5-2.5-1-4.5-0.5-7 0z" fill="#18181b" stroke="none" />
        <path d="M16 19c0 7 3.5 12 8 12s8-5 8-12" fill="#fff" />
        <rect x="17.5" y="20.5" width="5.5" height="4" rx="1.2" fill="#18181b" stroke="none" />
        <rect x="25" y="20.5" width="5.5" height="4" rx="1.2" fill="#18181b" stroke="none" />
        <path d="M23 22h2" strokeWidth="1.5" stroke="#18181b" />
        <path d="M16.5 22h1M30.5 22h1" strokeWidth="1.5" stroke="#18181b" />
        <path d="M22 27.5c1.2 0.8 3.5 0.8 4.5 0" strokeWidth="1.3" />
        <path d="M14 47c0-7 4-11 10-11s10 4 10 11" fill="#f8fafc" />
        <path d="M19 36l5 9 5-9" strokeWidth="1.3" />
      </svg>
    );
  }

  // idx === 5: Student with beanie / hoodie
  return (
    <svg viewBox="0 0 48 48" fill="none" stroke="#18181b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="24" cy="24" r="23" fill="#ffffff" stroke="#e4e4e7" strokeWidth="1" />
      <path d="M15 17c1-6 4.5-9 9-9s8 3 9 9z" fill="#18181b" stroke="none" />
      <path d="M14 17h20" strokeWidth="2.2" stroke="#18181b" strokeLinecap="round" />
      <path d="M17 19c0 6.5 3 11 7 11s7-4.5 7-11" fill="#fff" />
      <circle cx="20.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
      <circle cx="27.5" cy="22.5" r="1.2" fill="#18181b" stroke="none" />
      <path d="M22.5 26.5c0.8 0.7 2.2 0.7 3 0" strokeWidth="1.2" />
      <path d="M14 47c0-7 4-11 10-11s10 4 10 11" fill="#f8fafc" />
      <path d="M21 36c1 3 5 3 6 0" strokeWidth="1.4" />
    </svg>
  );
}

function ChatBox({
  messages,
  onSendMessage,
  ownId,
  playerName,
}: {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  ownId: string | null;
  playerName?: string;
}) {
  const [inputVal, setInputVal] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  // Live timer for updating relative time ("19s ago")
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (document.activeElement !== inputRef.current) {
          e.preventDefault();
          setIsOpen(true);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      } else if (e.key === "Escape") {
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputVal.trim()) return;
    onSendMessage(inputVal.trim());
    setInputVal("");
  };

  return (
    <div className={`chat-box-container ${isOpen ? "open" : "collapsed"}`}>
      <div className="chat-box-header" onClick={() => setIsOpen(!isOpen)}>
        <div className="chat-box-title">
          <svg
            className="chat-bubble-count-icon"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>{messages.length} messages</span>
        </div>
        <button
          type="button"
          className="chat-box-toggle-btn"
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen(!isOpen);
          }}
          title={isOpen ? "Minimize chat" : "Expand chat"}
        >
          {isOpen ? "−" : "+"}
        </button>
      </div>

      {isOpen && (
        <>
          <div className="chat-box-messages">
            {messages.length === 0 ? (
              <div className="chat-empty-hint">
                say something... press Enter to start chatting
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.isSystem) {
                  return (
                    <div key={msg.id} className="chat-msg-system">
                      <span className="chat-sys-icon">⚡</span>
                      <span>{msg.text}</span>
                    </div>
                  );
                }

                const isMe = msg.senderId === ownId;
                const displayName = isMe ? (playerName || msg.senderName) : msg.senderName;
                const formattedLoc = formatLocationCityCountry(msg.location);
                const isMobile = msg.device === "mobile";
                const deviceTitle = isMobile ? "Mobile device" : "Desktop computer";
                const timeAgo = formatTimeAgo(msg.timestamp, now);

                return (
                  <div key={msg.id} className="chat-msg-row">
                    <div className="chat-avatar-circle">
                      <AvatarSketch
                        name={msg.senderName}
                        character={msg.character}
                      />
                    </div>
                    <div className="chat-msg-content-col">
                      <div className="chat-meta-line">
                        <span className="chat-sender-name">{displayName}</span>
                        <span className="chat-sep">·</span>
                        {formattedLoc ? (
                          <>
                            <span className="chat-loc-name" title={msg.location}>
                              {formattedLoc}
                            </span>
                            <span className="chat-device-icon" title={deviceTitle}>
                              {isMobile ? <MobileIcon /> : <DesktopIcon />}
                            </span>
                            <span className="chat-sep">·</span>
                          </>
                        ) : (
                          <>
                            <span className="chat-device-icon" title={deviceTitle}>
                              {isMobile ? <MobileIcon /> : <DesktopIcon />}
                            </span>
                            <span className="chat-sep">·</span>
                          </>
                        )}
                        <span
                          className="chat-time-ago"
                          title={new Date(msg.timestamp).toLocaleTimeString()}
                        >
                          {timeAgo}
                        </span>
                      </div>
                      <div className="chat-msg-bubble">{msg.text}</div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-footer-area">
            <div className="chat-status-text">
              chatting as <strong>{playerName || "Isko"}</strong>
            </div>
            <form className="chat-box-input-form" onSubmit={handleSubmit}>
              <input
                ref={inputRef}
                type="text"
                className="chat-input"
                maxLength={200}
                placeholder="say something..."
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
              />
              <button type="submit" className="chat-send-btn" title="Send message">
                send ↵
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  const ecctrl = useRef<EcctrlHandle>(null);
  const currentAnimation = useRef<AnimationName>("Idle");
  const multiplayer = useMultiplayer();

  const [character, setCharacter] = useState<CharacterChoice>(() => {
    const saved = localStorage.getItem("iskolia_character");
    return saved === "iska" ? "iska" : "isko";
  });

  const [playerName, setPlayerName] = useState<string>(() => {
    return localStorage.getItem("iskolia_player_name") || "Isko";
  });

  const [playerLocation, setPlayerLocation] = useState<string>(() => {
    return localStorage.getItem("iskolia_player_location") || "";
  });

  const [gamePhase, setGamePhase] = useState<GamePhase>("intro");
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);

  // Auto-detect real device location on load (Geolocation API with IP fallback)
  useEffect(() => {
    let isCancelled = false;
    detectDeviceLocation().then((loc) => {
      if (isCancelled || !loc) return;
      setPlayerLocation(loc);
      localStorage.setItem("iskolia_player_location", loc);
      multiplayer.customizePlayer(playerName, character, loc);
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  // Sync profile & location to server as soon as multiplayer connects
  useEffect(() => {
    if (multiplayer.connected) {
      multiplayer.customizePlayer(
        playerName,
        character,
        playerLocation || undefined
      );
    }
  }, [multiplayer.connected]);

  const handleEnterCampus = () => {
    const finalName = playerName.trim() || (character === "iska" ? "Iska" : "Isko");
    const finalLoc = playerLocation.trim();
    setPlayerName(finalName);
    setPlayerLocation(finalLoc);
    localStorage.setItem("iskolia_character", character);
    localStorage.setItem("iskolia_player_name", finalName);
    if (finalLoc) localStorage.setItem("iskolia_player_location", finalLoc);

    multiplayer.customizePlayer(finalName, character, finalLoc || undefined);
    setGamePhase("transitioning");
  };

  const handleTransitionComplete = () => {
    setGamePhase("playing");
  };

  const handleReturnToOrbit = () => {
    setGamePhase("intro");
  };

  const handleSaveProfile = (chosen: CharacterChoice, name: string) => {
    setCharacter(chosen);
    setPlayerName(name);
    localStorage.setItem("iskolia_character", chosen);
    localStorage.setItem("iskolia_player_name", name);
    multiplayer.customizePlayer(name, chosen, playerLocation || undefined, getDeviceType());
  };

  const handleQuickSwitch = () => {
    const nextChar: CharacterChoice = character === "isko" ? "iska" : "isko";
    let nextName = playerName;
    if (playerName === "Isko" && nextChar === "iska") nextName = "Iska";
    if (playerName === "Iska" && nextChar === "isko") nextName = "Isko";

    setCharacter(nextChar);
    setPlayerName(nextName);
    localStorage.setItem("iskolia_character", nextChar);
    localStorage.setItem("iskolia_player_name", nextName);

    multiplayer.customizePlayer(nextName, nextChar, playerLocation, getDeviceType());
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        gamePhase !== "playing" ||
        isEditModalOpen
      ) {
        return;
      }
      if (e.key.toLowerCase() === "c") {
        handleQuickSwitch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [character, playerName, playerLocation, gamePhase, isEditModalOpen]);

  const ownChatBubble = multiplayer.chatBubbles.get(multiplayer.ownId || "")?.text;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        background: "#000",
      }}
    >
      {/* =====================================================
          3D CANVAS
          ===================================================== */}

      <Canvas
        shadows
        camera={{
          position: [12, 6, 12],
          fov: 55,
          near: 0.1,
          far: 1000,
        }}
        gl={{
          antialias: true,
        }}
      >
        <Physics gravity={[0, -9.81, 0]}>
          {/* PLAYER AVATAR */}
          <Player
            ecctrl={ecctrl}
            character={character}
            name={playerName}
            chatBubble={ownChatBubble}
            canControl={gamePhase === "playing"}
            onAnimationChange={(anim) => {
              currentAnimation.current = anim;
            }}
          />

          <MultiplayerSync
            socket={multiplayer.socketRef.current}
            ecctrl={ecctrl}
            character={character}
            location={playerLocation}
            currentAnimation={currentAnimation}
          />

          <RemotePlayers
            players={multiplayer.players}
            ownId={multiplayer.ownId}
            chatBubbles={multiplayer.chatBubbles}
          />

          {/* CAMERAS ACCORDING TO GAME PHASE */}
          {gamePhase === "intro" && <IntroCamera />}

          {gamePhase === "transitioning" && (
            <TransitionCamera
              target={ecctrl}
              onComplete={handleTransitionComplete}
            />
          )}

          {gamePhase === "playing" && <PlayerCamera target={ecctrl} />}

          {/* WORLD */}
          <World />
        </Physics>
      </Canvas>

      {/* =====================================================
          PHASE 1: STARTING INTRO SCREEN
          ===================================================== */}

      {gamePhase === "intro" && (
        <StartIntroScreen
          character={character}
          name={playerName}
          onSelectCharacter={(c) => {
            setCharacter(c);
            localStorage.setItem("iskolia_character", c);
          }}
          onNameChange={setPlayerName}
          onEnter={handleEnterCampus}
          onlineCount={multiplayer.players.size}
          isConnected={multiplayer.connected}
        />
      )}

      {/* =====================================================
          PHASE 2: ENTERING TRANSITION OVERLAY
          ===================================================== */}

      {gamePhase === "transitioning" && (
        <EnteringOverlay playerName={playerName} />
      )}

      {/* =====================================================
          PHASE 3: IN-GAME HUD & CONTROLS
          ===================================================== */}

      {gamePhase === "playing" && (
        <>
          <div className="hud-top-bar">
            {/* RETURN TO ORBIT VIEW BUTTON */}
            <button
              type="button"
              className="hud-orbit-btn"
              onClick={handleReturnToOrbit}
              title="Return to Orbit View / Campus Tour"
            >
              <span>🎥</span>
              <span>Orbit View</span>
            </button>

            {/* QUICK SWITCH CHARACTER BUTTON */}
            <button
              type="button"
              className={`char-switch-btn ${character === "isko" ? "is-iska" : "is-isko"}`}
              onClick={handleQuickSwitch}
              title={`Switch character to ${character === "isko" ? "Iska" : "Isko"} (Press C)`}
            >
              <span>{character === "isko" ? "👧 Switch to Iska" : "👦 Switch to Isko"}</span>
              <span className="kbd-badge">C</span>
            </button>

            {/* EDIT PROFILE BUTTON */}
            <button
              type="button"
              className="hud-btn"
              onClick={() => setIsEditModalOpen(true)}
              title="Edit Profile"
            >
              <span>⚙️</span>
            </button>

            {/* ONLINE BADGE */}
            <div className="online-indicator" aria-live="polite">
              <span
                className={multiplayer.connected ? "online-dot" : "offline-dot"}
              />
              <span>
                {multiplayer.connected
                  ? `${multiplayer.players.size} online`
                  : "Offline"}
              </span>
            </div>
          </div>

          {/* CAMPUS CHAT BOX */}
          <ChatBox
            messages={multiplayer.messages}
            onSendMessage={multiplayer.sendMessage}
            ownId={multiplayer.ownId}
            playerName={playerName}
          />

          {/* MOBILE JOYSTICK & BUTTONS */}
          <MobileControls />

          {/* EDIT PROFILE MODAL */}
          <EditProfileModal
            isOpen={isEditModalOpen}
            initialCharacter={character}
            initialName={playerName}
            onClose={() => setIsEditModalOpen(false)}
            onSave={handleSaveProfile}
          />
        </>
      )}
    </div>
  );
}

// ============================================================
// PRELOAD
// ============================================================

useGLTF.preload("/models/player.glb");
useGLTF.preload("/models/iska.glb");
useGLTF.preload("/models/character.glb");

