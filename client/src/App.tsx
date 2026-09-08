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

type PlayerRotation = {
  y: number;
};

type PlayerState = {
  id: string;
  name?: string;
  character?: CharacterChoice;
  position: { x: number; y: number; z: number };
  rotation?: PlayerRotation;
  animation?: AnimationName;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  character?: CharacterChoice;
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
    }) => void;
    "player:customize": (data: {
      name?: string;
      character?: CharacterChoice;
    }) => void;
    "chat:send": (data: { text: string }) => void;
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
  chatBubble,
  onAnimationChange,
  canControl = true,
}: {
  ecctrl: React.RefObject<EcctrlHandle | null>;
  character?: CharacterChoice;
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

      {chatBubble && (
        <Html position={[0, 1.8, 0]} center distanceFactor={14}>
          <div className="chat-speech-bubble">
            {chatBubble}
          </div>
        </Html>
      )}
    </Ecctrl>
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

    // Smooth position interpolation (lerp)
    const posLerp = Math.min(1, delta * 15);
    group.current.position.lerp(targetPos.current, posLerp);

    // Smooth rotation interpolation around Y
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
          <span>{player.name || `${charType === "iska" ? "Iska" : "Isko"} #${player.id.slice(0, 4)}`}</span>
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
  currentAnimation,
}: {
  socket: MultiplayerSocket | null;
  ecctrl: React.RefObject<EcctrlHandle | null>;
  character: CharacterChoice;
  currentAnimation: React.RefObject<AnimationName>;
}) {
  const lastSentAt = useRef(0);
  const lastPos = useRef(new THREE.Vector3());
  const lastRotY = useRef<number>(0);
  const lastAnim = useRef<AnimationName>("Idle");
  const lastChar = useRef<CharacterChoice>(character);

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

    if (
      distMoved > 0.005 ||
      rotDiff > 0.015 ||
      animChanged ||
      charChanged ||
      lastSentAt.current >= 500
    ) {
      lastSentAt.current = 0;
      lastPos.current.copy(position);
      lastRotY.current = rotY;
      lastAnim.current = anim;
      lastChar.current = character;

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
      });
    }
  });

  return null;
}

// ============================================================
// WORLD
// ============================================================


// ============================================================
// STAIRS
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
// ============================================================
// WORLD
// ============================================================

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

  const customizePlayer = (name: string, character: CharacterChoice) => {
    socketRef.current?.emit("player:customize", { name, character });
  };

  const sendMessage = (text: string) => {
    socketRef.current?.emit("chat:send", { text });
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
            Choose your student avatar and enter the real-time virtual university
          </p>
        </div>

        {/* CHARACTER SELECTION WITH LIVE 3D PREVIEW */}
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
        <p className="char-modal-subtitle">Customize your character and display name</p>

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
              onSave(selected, name.trim() || (selected === "iska" ? "Iska" : "Isko"));
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
// CHAT BOX COMPONENT
// ============================================================

function ChatBox({
  messages,
  onSendMessage,
  ownId,
}: {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  ownId: string | null;
}) {
  const [inputVal, setInputVal] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

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
          <span>💬</span>
          <span>Campus Chat</span>
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
                No messages yet. Press Enter to say hi! 👋
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.isSystem) {
                  return (
                    <div key={msg.id} className="chat-msg system">
                      <span className="chat-sys-icon">⚡</span>
                      <span>{msg.text}</span>
                    </div>
                  );
                }

                const isMe = msg.senderId === ownId;
                const charType = msg.character || "isko";

                return (
                  <div key={msg.id} className={`chat-msg ${isMe ? "own" : ""}`}>
                    <span className={`chat-sender-badge ${charType}`}>
                      {isMe ? "You" : msg.senderName}
                    </span>
                    <span className="chat-msg-text">{msg.text}</span>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-box-input-form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="chat-input"
              maxLength={200}
              placeholder="Press Enter to chat..."
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
            />
            <button type="submit" className="chat-send-btn" title="Send message">
              ➤
            </button>
          </form>
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

  const [gamePhase, setGamePhase] = useState<GamePhase>("intro");
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);

  const handleEnterCampus = () => {
    const finalName = playerName.trim() || (character === "iska" ? "Iska" : "Isko");
    setPlayerName(finalName);
    localStorage.setItem("iskolia_character", character);
    localStorage.setItem("iskolia_player_name", finalName);

    multiplayer.customizePlayer(finalName, character);
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
    multiplayer.customizePlayer(name, chosen);
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

    multiplayer.customizePlayer(nextName, nextChar);
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
  }, [character, playerName, gamePhase, isEditModalOpen]);

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
              title="Edit Profile & Character"
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

