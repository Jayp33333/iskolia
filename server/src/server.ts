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

export type CharacterChoice = "isko" | "iska";

export interface PlayerState {
  id: string;
  name: string;
  character: CharacterChoice;
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

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  character?: CharacterChoice;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

const chatHistory: ChatMessage[] = [];

io.on("connection", (socket: Socket) => {
  const shortId = socket.id.slice(0, 4).toUpperCase();
  const newPlayer: PlayerState = {
    id: socket.id,
    name: `Player #${shortId}`,
    character: "isko",
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

  // Send recent chat history
  socket.emit("chat:history", chatHistory);

  // Notify other players
  socket.broadcast.emit("player:joined", newPlayer);

  // System notification
  const joinMsg: ChatMessage = {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    senderId: "system",
    senderName: "System",
    text: `${newPlayer.name} joined the campus`,
    timestamp: Date.now(),
    isSystem: true,
  };
  chatHistory.push(joinMsg);
  if (chatHistory.length > 50) chatHistory.shift();
  io.emit("chat:message", joinMsg);

  // Handle character & profile customization
  socket.on(
    "player:customize",
    (data: { name?: string; character?: CharacterChoice }) => {
      const existing = players.get(socket.id);
      if (!existing) return;

      if (data.name && typeof data.name === "string") {
        existing.name = data.name.trim().slice(0, 20) || existing.name;
      }

      if (data.character === "isko" || data.character === "iska") {
        existing.character = data.character;
      }

      io.emit("player:updated", existing);
    }
  );

  // Handle chat messages
  socket.on("chat:send", (data: { text: string }) => {
    const existing = players.get(socket.id);
    if (!existing) return;

    const raw = typeof data?.text === "string" ? data.text : "";
    const cleanText = raw.trim().slice(0, 250);
    if (!cleanText) return;

    const newMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      senderId: socket.id,
      senderName: existing.name,
      character: existing.character,
      text: cleanText,
      timestamp: Date.now(),
    };

    chatHistory.push(newMsg);
    if (chatHistory.length > 50) chatHistory.shift();

    io.emit("chat:message", newMsg);
  });

  // Handle movement updates
  socket.on(
    "player:move",
    (data: {
      position: PlayerPosition;
      rotation?: PlayerRotation;
      animation?: AnimationName;
      character?: CharacterChoice;
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

      if (data.character === "isko" || data.character === "iska") {
        existing.character = data.character;
      }

      // Broadcast movement to all other clients
      socket.broadcast.emit("player:moved", existing);
    }
  );

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    const player = players.get(socket.id);
    players.delete(socket.id);
    console.log(
      `[-] Player disconnected: ${socket.id} (${reason}) | Remaining: ${players.size}`
    );
    io.emit("player:left", { id: socket.id });

    if (player) {
      const leaveMsg: ChatMessage = {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        senderId: "system",
        senderName: "System",
        text: `${player.name} left the campus`,
        timestamp: Date.now(),
        isSystem: true,
      };
      chatHistory.push(leaveMsg);
      if (chatHistory.length > 50) chatHistory.shift();
      io.emit("chat:message", leaveMsg);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Multiplayer server running on http://localhost:${PORT}`);
});
