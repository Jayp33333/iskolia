import http from "node:http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server, Socket } from "socket.io";

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
}

export interface PlayerRotation {
  y: number;
}

export type AnimationName = "Idle" | "Walk" | "Run" | "Jump" | "RunJump";

export interface PlayerState {
  id: string;
  name: string;
  position: PlayerPosition;
  rotation: PlayerRotation;
  animation: AnimationName;
}

const players = new Map<string, PlayerState>();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    playersCount: players.size,
    uptime: process.uptime(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    message: "Iskolia Multiplayer Server Running",
    playersOnline: players.size,
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

io.on("connection", (socket: Socket) => {
  const shortId = socket.id.slice(0, 4).toUpperCase();
  const newPlayer: PlayerState = {
    id: socket.id,
    name: `Player #${shortId}`,
    position: { x: 0, y: 1, z: 0 },
    rotation: { y: 0 },
    animation: "Idle",
  };

  players.set(socket.id, newPlayer);
  console.log(
    `[+] Player joined: ${socket.id} (${newPlayer.name}) | Total: ${players.size}`
  );

  // Send session to the new client
  socket.emit("session", { id: socket.id, player: newPlayer });

  // Send currently connected players to the new client
  socket.emit("players", Array.from(players.values()));

  // Notify other players
  socket.broadcast.emit("player:joined", newPlayer);

  // Handle movement updates
  socket.on(
    "player:move",
    (data: {
      position: PlayerPosition;
      rotation?: PlayerRotation;
      animation?: AnimationName;
    }) => {
      const existing = players.get(socket.id);
      if (!existing) return;

      if (data.position) {
        existing.position = {
          x: Number(data.position.x) || 0,
          y: Number(data.position.y) || 0,
          z: Number(data.position.z) || 0,
        };
      }

      if (data.rotation) {
        existing.rotation = {
          y: Number(data.rotation.y) || 0,
        };
      }

      if (data.animation) {
        existing.animation = data.animation;
      }

      // Broadcast movement to all other clients
      socket.broadcast.emit("player:moved", existing);
    }
  );

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    players.delete(socket.id);
    console.log(
      `[-] Player disconnected: ${socket.id} (${reason}) | Remaining: ${players.size}`
    );
    io.emit("player:left", { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Multiplayer server running on http://localhost:${PORT}`);
});
