import http from "node:http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import mongoose, { Schema } from "mongoose";
import { Server, Socket } from "socket.io";

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || CLIENT_URL)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;
const isProduction = process.env.NODE_ENV === "production";
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

if (isProduction && !JWT_SECRET) {
  throw new Error("JWT_SECRET must be set when NODE_ENV=production");
}

const signingSecret = JWT_SECRET || "iskolia-development-only-secret";

type AuthProvider = "google" | "facebook" | "development";

interface AuthUser {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  provider: AuthProvider;
}

interface AuthTokenPayload extends JwtPayload {
  user: AuthUser;
}

const oauthCodes = new Map<string, { user: AuthUser; expiresAt: number }>();

interface StoredUser {
  provider: AuthProvider;
  providerUserId: string;
  name: string;
  email?: string;
  picture?: string;
  firstSignInAt: Date;
  lastSignInAt: Date;
  signInCount: number;
}

const userSchema = new Schema<StoredUser>(
  {
    provider: { type: String, enum: ["google", "facebook", "development"], required: true },
    providerUserId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true, maxlength: 320, unique: true, sparse: true },
    picture: { type: String, maxlength: 2048 },
    firstSignInAt: { type: Date, required: true },
    lastSignInAt: { type: Date, required: true },
    signInCount: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);
userSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
userSchema.index({ lastSignInAt: -1 });

const User = mongoose.model<StoredUser>("User", userSchema);
let databaseReady = false;

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.warn("MongoDB is not configured: signed-in users will not be saved.");
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    databaseReady = true;
    console.log("MongoDB connected: sign-in history is enabled.");
  } catch (error) {
    console.error("MongoDB connection failed: sign-in history is disabled.", error);
  }
}

function isAdmin(user: AuthUser) {
  return Boolean(user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
}

function accountKey(user: AuthUser) {
  return user.email?.trim().toLowerCase() || `${user.provider}:${user.id}`;
}

async function saveSignedInUser(user: AuthUser) {
  if (!databaseReady || user.provider === "development") return;

  try {
    const now = new Date();
    await User.findOneAndUpdate(
      user.email ? { email: user.email.trim().toLowerCase() } : { provider: user.provider, providerUserId: user.id },
      {
        $set: {
          name: user.name.trim().slice(0, 100),
          email: user.email?.trim().toLowerCase(),
          picture: user.picture?.trim(),
          lastSignInAt: now,
        },
        $setOnInsert: { firstSignInAt: now },
        $inc: { signInCount: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  } catch (error) {
    console.error("Could not save signed-in user.", error);
  }
}

function providerIsConfigured(provider: "google" | "facebook") {
  return provider === "google"
    ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
    : Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
}

function callbackUrl(provider: "google" | "facebook") {
  return `${PUBLIC_SERVER_URL}/auth/${provider}/callback`;
}

function issueToken(user: AuthUser) {
  return jwt.sign({ user }, signingSecret, { expiresIn: "7d" });
}

function readToken(token: unknown): AuthUser | null {
  if (typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, signingSecret) as AuthTokenPayload;
    const user = payload.user;
    if (!user || typeof user.id !== "string" || typeof user.name !== "string") return null;
    if (user.provider !== "google" && user.provider !== "facebook" && user.provider !== "development") {
      return null;
    }
    if (user.provider === "development" && isProduction) return null;
    return user;
  } catch {
    return null;
  }
}

function redirectToClient(res: express.Response, params: Record<string, string>) {
  const redirectUrl = new URL(CLIENT_URL);
  Object.entries(params).forEach(([key, value]) => redirectUrl.searchParams.set(key, value));
  res.redirect(redirectUrl.toString());
}

function clearOauthState(res: express.Response) {
  res.clearCookie("iskolia_oauth_state", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/auth",
  });
}

const app = express();
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json());

app.get("/auth/providers", (_req, res) => {
  res.json({
    google: providerIsConfigured("google"),
    facebook: providerIsConfigured("facebook"),
    development: !isProduction,
  });
});

function startOAuth(provider: "google" | "facebook", res: express.Response) {
  if (!providerIsConfigured(provider)) {
    res.status(503).json({ error: `${provider} sign-in is not configured on this server.` });
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  res.cookie("iskolia_oauth_state", `${provider}:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 10 * 60 * 1000,
    path: "/auth",
  });

  const authorizationUrl = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://www.facebook.com/dialog/oauth",
  );
  if (provider === "google") {
    authorizationUrl.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: callbackUrl("google"),
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    }).toString();
  } else {
    authorizationUrl.search = new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID!,
      redirect_uri: callbackUrl("facebook"),
      response_type: "code",
      // `public_profile` is available to every Facebook Login app. Email is
      // optional and some Meta app configurations reject it as an invalid scope.
      scope: "public_profile",
      state,
    }).toString();
  }
  res.redirect(authorizationUrl.toString());
}

app.get("/auth/google", (_req, res) => startOAuth("google", res));
app.get("/auth/facebook", (_req, res) => startOAuth("facebook", res));

app.get("/auth/:provider/callback", async (req, res) => {
  const provider = req.params.provider;
  if (provider !== "google" && provider !== "facebook") {
    res.status(404).send("Unknown sign-in provider.");
    return;
  }

  const encodedStateCookie = req.headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("iskolia_oauth_state="))
    ?.slice("iskolia_oauth_state=".length);
  let stateCookie = "";
  try {
    stateCookie = encodedStateCookie ? decodeURIComponent(encodedStateCookie) : "";
  } catch {
    // A malformed cookie cannot be trusted and will fail the state check below.
  }
  const state = typeof req.query.state === "string" ? req.query.state : "";
  clearOauthState(res);

  if (req.query.error || stateCookie !== `${provider}:${state}`) {
    redirectToClient(res, { auth_error: "Sign-in could not be verified. Please try again." });
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    redirectToClient(res, { auth_error: "The sign-in provider did not return an authorization code." });
    return;
  }

  try {
    let user: AuthUser;
    if (provider === "google") {
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl("google"),
          grant_type: "authorization_code",
        }),
      });
      const token = (await tokenResponse.json()) as { access_token?: string };
      if (!tokenResponse.ok || !token.access_token) throw new Error("Google token exchange failed");
      const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const profile = (await profileResponse.json()) as {
        sub?: string;
        name?: string;
        email?: string;
        email_verified?: boolean;
        picture?: string;
      };
      if (!profileResponse.ok || !profile.sub || !profile.name || !profile.email || profile.email_verified === false) {
        throw new Error("Google profile is missing a verified email address");
      }
      user = { id: profile.sub, name: profile.name, email: profile.email, picture: profile.picture, provider };
    } else {
      const tokenUrl = new URL("https://graph.facebook.com/oauth/access_token");
      tokenUrl.search = new URLSearchParams({
        client_id: process.env.FACEBOOK_APP_ID!,
        client_secret: process.env.FACEBOOK_APP_SECRET!,
        redirect_uri: callbackUrl("facebook"),
        code,
      }).toString();
      const tokenResponse = await fetch(tokenUrl);
      const token = (await tokenResponse.json()) as {
        access_token?: string;
        error?: { message?: string; type?: string; code?: number };
      };
      if (!tokenResponse.ok || !token.access_token) {
        throw new Error(`Facebook token exchange failed: ${token.error?.message || token.error?.type || "unknown error"}`);
      }
      const profileUrl = new URL("https://graph.facebook.com/me");
      profileUrl.search = new URLSearchParams({ fields: "id,name,email,picture", access_token: token.access_token }).toString();
      const profileResponse = await fetch(profileUrl);
      const profile = (await profileResponse.json()) as {
        id?: string;
        name?: string;
        email?: string;
        picture?: { data?: { url?: string } };
        error?: { message?: string; type?: string; code?: number };
      };
      if (!profileResponse.ok || !profile.id || !profile.name) {
        throw new Error(`Facebook profile request failed: ${profile.error?.message || profile.error?.type || "profile is incomplete"}`);
      }
      user = { id: profile.id, name: profile.name, email: profile.email, picture: profile.picture?.data?.url, provider };
    }

    await saveSignedInUser(user);
    const authCode = crypto.randomBytes(32).toString("hex");
    oauthCodes.set(authCode, { user, expiresAt: Date.now() + 60_000 });
    redirectToClient(res, { auth_code: authCode });
  } catch (error) {
    console.error("OAuth callback failed", error);
    redirectToClient(res, { auth_error: "Sign-in failed. Please try again." });
  }
});

app.post("/auth/exchange", (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const pending = oauthCodes.get(code);
  oauthCodes.delete(code);
  if (!pending || pending.expiresAt < Date.now()) {
    res.status(401).json({ error: "Your sign-in link has expired. Please try again." });
    return;
  }
  res.json({ token: issueToken(pending.user), user: pending.user, isAdmin: isAdmin(pending.user) });
});

app.get("/auth/me", (req, res) => {
  const user = readToken(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
  if (!user) {
    res.status(401).json({ error: "Session is invalid or expired." });
    return;
  }
  res.json({ user, isAdmin: isAdmin(user) });
});

app.get("/admin/dashboard", async (req, res) => {
  const user = readToken(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
  if (!user || !isAdmin(user)) {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  if (!databaseReady) {
    res.status(503).json({ error: "MongoDB is not connected. Set MONGODB_URI on the server." });
    return;
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const [users, total, googleUsers, facebookUsers] = await Promise.all([
    User.find({}, { providerUserId: 0 })
      .sort({ lastSignInAt: -1 })
      .limit(limit)
      .lean()
      .exec(),
    User.countDocuments(),
    User.countDocuments({ provider: "google" }),
    User.countDocuments({ provider: "facebook" }),
  ]);
  const activeUsers = Array.from(players.values()).map((player) => {
    const socket = io.sockets.sockets.get(player.id);
    const activeUser = socket?.data.user as AuthUser | undefined;
    return {
      id: player.id,
      name: player.name,
      provider: activeUser?.provider || "unknown",
      email: activeUser?.email,
      connectedAt: socket?.handshake.issued || new Date().toISOString(),
    };
  });
  res.json({
    totalUsers: total,
    googleUsers,
    facebookUsers,
    activePlayers: activeUsers.length,
    activeUsers,
    users,
  });
});

app.post("/auth/development", (_req, res) => {
  if (isProduction) {
    res.status(404).end();
    return;
  }
  const user: AuthUser = {
    id: `dev-${crypto.randomUUID()}`,
    name: "Developer",
    provider: "development",
  };
  res.json({ token: issueToken(user), user });
});

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

export type DeviceType = "desktop" | "mobile";

export interface PlayerState {
  id: string;
  name: string;
  character: CharacterChoice;
  location?: string;
  device?: DeviceType;
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
    origin: CORS_ORIGINS,
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
  location?: string;
  device?: DeviceType;
  text: string;
  timestamp: number;
  isSystem?: boolean;
  recipientId?: string;
  isPrivate?: boolean;
}

const chatHistory: ChatMessage[] = [];
const activeAccountSockets = new Map<string, string>();

io.use((socket, next) => {
  const user = readToken(socket.handshake.auth?.token);
  if (!user) {
    next(new Error("Authentication required"));
    return;
  }
  const key = accountKey(user);
  if (activeAccountSockets.has(key)) {
    next(new Error("This account is already active on another device."));
    return;
  }
  socket.data.user = user;
  socket.data.accountKey = key;
  next();
});

io.on("connection", (socket: Socket) => {
  const user = socket.data.user as AuthUser;
  const userAccountKey = socket.data.accountKey as string;
  activeAccountSockets.set(userAccountKey, socket.id);
  const shortId = socket.id.slice(0, 4).toUpperCase();
  const newPlayer: PlayerState = {
    id: socket.id,
    name: user.name.trim().slice(0, 20) || `Player #${shortId}`,
    character: "isko",
    device: "desktop",
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
    (data: { name?: string; character?: CharacterChoice; location?: string; device?: DeviceType }) => {
      const existing = players.get(socket.id);
      if (!existing) return;

      if (data.name && typeof data.name === "string") {
        existing.name = data.name.trim().slice(0, 20) || existing.name;
      }

      if (data.character === "isko" || data.character === "iska") {
        existing.character = data.character;
      }

      if (data.location && typeof data.location === "string") {
        existing.location = data.location.trim().slice(0, 45) || existing.location;
      }

      if (data.device === "mobile" || data.device === "desktop") {
        existing.device = data.device;
      }

      io.emit("player:updated", existing);
    }
  );

  // Handle chat messages
  socket.on("chat:send", (data: { text: string; device?: DeviceType; recipientId?: string }) => {
    const existing = players.get(socket.id);
    if (!existing) return;

    const raw = typeof data?.text === "string" ? data.text : "";
    const cleanText = raw.trim().slice(0, 250);
    if (!cleanText) return;

    const device =
      data?.device === "mobile" || data?.device === "desktop"
        ? data.device
        : existing.device || "desktop";

    const newMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      senderId: socket.id,
      senderName: existing.name,
      character: existing.character,
      location: existing.location,
      device: device,
      text: cleanText,
      timestamp: Date.now(),
    };

    const recipientId =
      typeof data?.recipientId === "string" && data.recipientId !== socket.id
        ? data.recipientId
        : undefined;

    if (recipientId && !players.has(recipientId)) return;

    if (recipientId) {
      newMsg.recipientId = recipientId;
      newMsg.isPrivate = true;
      io.to(socket.id).to(recipientId).emit("chat:message", newMsg);
      return;
    }

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
      location?: string;
      device?: DeviceType;
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

      if (data.location && typeof data.location === "string") {
        existing.location = data.location.trim().slice(0, 45);
      }

      if (data.device === "mobile" || data.device === "desktop") {
        existing.device = data.device;
      }

      // Broadcast movement to all other clients
      socket.broadcast.emit("player:moved", existing);
    }
  );

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    const player = players.get(socket.id);
    players.delete(socket.id);
    if (activeAccountSockets.get(userAccountKey) === socket.id) {
      activeAccountSockets.delete(userAccountKey);
    }
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

void connectDatabase().finally(() => server.listen(PORT, () => {
  console.log(`🚀 Multiplayer server running on http://localhost:${PORT}`);
}));
