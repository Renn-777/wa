import "dotenv/config";

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OWNER_ID = String(process.env.OWNER_ID || "");
export const OWNER_USERNAME = process.env.OWNER_USERNAME || "";
export const MENU_PHOTO_URL = process.env.MENU_PHOTO_URL || "";
export const MENU_VIDEO_URL = process.env.MENU_VIDEO_URL || "";

export const FORCE_JOIN_CHANNEL = process.env.FORCE_JOIN_CHANNEL || ""; // contoh: @nama_channel

export const MAX_PAIR_PER_USER = 5;
export const SESSION_ROOT = "./sessions";

if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN belum diisi di file .env");
    process.exit(1);
}
if (!OWNER_ID) {
    console.error("❌ OWNER_ID belum diisi di file .env");
    process.exit(1);
}