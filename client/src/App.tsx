import { Canvas, useFrame } from "@react-three/fiber";
import { Sky, useGLTF, useAnimations, Html } from "@react-three/drei";
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

type MultiplayerSocket = Socket<
  {
    session: (session: { id: string; player?: PlayerState }) => void;
    players: (players: PlayerState[]) => void;
    "player:joined": (player: PlayerState) => void;
    "player:moved": (player: PlayerState) => void;
    "player:updated": (player: PlayerState) => void;
    "player:left": (data: { id: string }) => void;
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
      keys.current.add(event.key.toLowerCase());
    };

    const handleKeyUp = (event: KeyboardEvent) => {
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
      <primitive object={modelClone} scale={1} position={[0, -0.8, 0]} />
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
  onAnimationChange,
}: {
  ecctrl: React.RefObject<EcctrlHandle | null>;
  character?: CharacterChoice;
  onAnimationChange?: (animation: AnimationName) => void;
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

function RemotePlayer({ player }: { player: PlayerState }) {
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
    </group>
  );
}

function RemotePlayers({
  players,
  ownId,
}: {
  players: Map<string, PlayerState>;
  ownId: string | null;
}) {
  return Array.from(players.values())
    .filter((player) => player.id !== ownId)
    .map((player) => <RemotePlayer key={player.id} player={player} />);
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

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const customizePlayer = (name: string, character: CharacterChoice) => {
    socketRef.current?.emit("player:customize", { name, character });
  };

  return { connected, ownId, players, socketRef, customizePlayer };
}

// ============================================================
// CHARACTER SELECT MODAL
// ============================================================

function CharacterSelectModal({
  isOpen,
  initialCharacter,
  initialName,
  onConfirm,
}: {
  isOpen: boolean;
  initialCharacter: CharacterChoice;
  initialName: string;
  onConfirm: (character: CharacterChoice, name: string) => void;
}) {
  const [selected, setSelected] = useState<CharacterChoice>(initialCharacter);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    setSelected(initialCharacter);
    setName(initialName);
  }, [initialCharacter, initialName, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="char-modal-backdrop">
      <div className="char-modal-box">
        <div>
          <h2 className="char-modal-title">Welcome to Iskolia</h2>
          <p className="char-modal-subtitle">Choose your character to enter campus</p>
        </div>

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

        <button
          type="button"
          className="btn-enter-world"
          onClick={() =>
            onConfirm(
              selected,
              name.trim() || (selected === "iska" ? "Iska" : "Isko"),
            )
          }
        >
          Enter Campus 🚀
        </button>
      </div>
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

  const [hasStarted, setHasStarted] = useState<boolean>(() => {
    return localStorage.getItem("iskolia_has_started") === "true";
  });

  const [isModalOpen, setIsModalOpen] = useState<boolean>(!hasStarted);

  const handleSelectCharacter = (chosen: CharacterChoice, name: string) => {
    setCharacter(chosen);
    setPlayerName(name);
    setHasStarted(true);
    setIsModalOpen(false);

    localStorage.setItem("iskolia_character", chosen);
    localStorage.setItem("iskolia_player_name", name);
    localStorage.setItem("iskolia_has_started", "true");

    multiplayer.customizePlayer(name, chosen);
  };

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
          3D GAME
          ===================================================== */}

      <Canvas
        shadows
        camera={{
          position: [0, 3, 8],

          fov: 60,

          near: 0.1,

          far: 1000,
        }}
        gl={{
          antialias: true,
        }}
      >
        <Physics gravity={[0, -9.81, 0]}>
          {/* PLAYER */}

          <Player
            ecctrl={ecctrl}
            character={character}
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
          />

          {/* CAMERA */}

          <PlayerCamera target={ecctrl} />

          {/* WORLD */}

          <World />
        </Physics>
      </Canvas>

      {/* =====================================================
          TOP HUD
          ===================================================== */}

      <div className="hud-top-bar">
        <button
          type="button"
          className="hud-btn"
          onClick={() => setIsModalOpen(true)}
          title="Change your character"
        >
          <span>{character === "iska" ? "👧 Iska" : "👦 Isko"}</span>
          <span style={{ opacity: 0.6, fontSize: 11 }}>⇄</span>
        </button>

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

      {/* =====================================================
          START / CHARACTER SELECT MODAL
          ===================================================== */}

      <CharacterSelectModal
        isOpen={isModalOpen}
        initialCharacter={character}
        initialName={playerName}
        onConfirm={handleSelectCharacter}
      />

      {/* =====================================================
          MOBILE UI
          ===================================================== */}

      <MobileControls />
    </div>
  );
}

// ============================================================
// PRELOAD
// ============================================================

useGLTF.preload("/models/player.glb");
useGLTF.preload("/models/iska.glb");
useGLTF.preload("/models/character.glb");

