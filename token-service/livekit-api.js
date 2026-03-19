import { mustEnv, toHttpUrl } from "./utils.js";
import { RoomServiceClient } from "livekit-server-sdk";

export const LIVEKIT_URL = mustEnv("LIVEKIT_URL");
export const LIVEKIT_URL_INTERNAL = process.env.LIVEKIT_URL_INTERNAL || LIVEKIT_URL;
export const LIVEKIT_API_KEY = mustEnv("LIVEKIT_API_KEY");
export const LIVEKIT_API_SECRET = mustEnv("LIVEKIT_API_SECRET");
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:5173";
export const LIVEKIT_HTTP_URL = toHttpUrl(LIVEKIT_URL_INTERNAL);

export const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

export const DEFAULT_ROOM_NAME =
  process.env.SINGLE_ROOM_NAME ||
  process.env.DEFAULT_ROOM_NAME ||
  process.env.ROOM_NAME ||
  `room_${randomId(12)}`;
