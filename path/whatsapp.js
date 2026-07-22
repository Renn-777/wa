import fs from "fs";
import path from "path";
import pino from "pino";
import { Boom } from "@hapi/boom";
import * as baileys from "@whiskeysockets/baileys";
import { log } from "./logger.js";

const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;

const { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = baileys;

import { SESSION_ROOT, OWNER_ID } from "../setting/config.js";
import { removePairNumber } from "../database.js";

// key = `${uid}_${number}` -> { sock, status, reconnecting, isPairing }
export const waClients = new Map();

// guard biar gak ada 2 proses init jalan bareng buat key yang sama
const initializingKeys = new Set();

export function clientKey(uid, number) {
    return `${uid}_${number}`;
}

function getSessionPath(uid, number) {
    return path.join(SESSION_ROOT, String(uid), String(number));
}

function tag(uid, number) {
    return `Key: ${uid} | Nomor: ${number}`;
}

export function getClient(uid, number) {
    return waClients.get(clientKey(uid, number));
}

async function deleteSessionFiles(uid, number) {
    try {
        await fs.promises.rm(getSessionPath(uid, number), { recursive: true, force: true });
    } catch {}
}


// ----------- ( fungsi: sharedSessionKeyFromToken ) ------------ //

    export function sharedSessionKeyFromToken(token) {
        const botId = String(token).split(":")[0];
        return `sub_${botId}`;
    }


// ----------- ( fungsi: notifyOwner, laporan error ke owner via Telegram ) ------------ //

    async function notifyOwner(bot, message) {
        if (!bot?.api || !OWNER_ID) return;
        try {
            await bot.api.sendMessage(OWNER_ID, `🚨 *WA ERROR LOG*\n\n${message}`, { parse_mode: "Markdown" });
        } catch (err) {
            log.error(`Gagal kirim notif ke owner: ${err.message}`);
        }
    }


// ----------- ( fungsi: getReconnectDelay, exponential backoff + jitter ) ------------ //

    function getReconnectDelay(retryCount) {
        const base = 5000;
        const exponential = Math.min(base * 2 ** retryCount, 90000);
        const jitter = Math.floor(Math.random() * 2000);
        return exponential + jitter;
    }


// ----------- ( fungsi: initWhatsappForNumber ) ------------ //
// uid           -> STORAGE KEY (bisa telegram id asli buat bot utama,
//                  atau "sub_<botId>" buat sesi bareng sub-bot)
// notifyTarget  -> chat id ASLI yang bakal di-DM kalau ada error/logout.
//                  Default ke uid kalau gak diisi (dipakai bot utama).

    export async function initWhatsappForNumber(bot, uid, number, retryCount = 0, notifyTarget = null) {
        const MAX_RETRIES = 5;
        const key = clientKey(uid, number);
        const sessionPath = getSessionPath(uid, number);
        const notifyTo = notifyTarget || uid;

        const oldClient = waClients.get(key);

        // kalau session udah beneran kebuka, jangan init ulang
        if (oldClient?.sock && oldClient.status === "open") {
            log.info(`Session sudah aktif, skip init ulang | ${tag(uid, number)}`);
            return oldClient.sock;
        }

        // kalau lagi proses connecting, JANGAN bikin socket kedua buat key yang sama.
        // Ini penyebab utama "closed anomali": 2 socket buat 1 nomor bikin WhatsApp
        // nutup salah satunya dengan reason connectionReplaced, dikira logout.
        if (oldClient?.sock && oldClient.status === "connecting") {
            log.warning(`Session masih dalam proses connecting, skip init dobel | ${tag(uid, number)}`);
            return oldClient.sock;
        }

        if (initializingKeys.has(key)) {
            log.warning(`Init sudah berjalan, skip duplikat | ${tag(uid, number)}`);
            return oldClient?.sock || null;
        }
        initializingKeys.add(key);

        try {
            if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

            log.loading(`Menghubungkan WhatsApp... | ${tag(uid, number)}`);

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

            const sock = makeWASocket({
                logger: pino({ level: "silent" }),
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                syncFullHistory: false,
                markOnlineOnConnect: false,
                retryRequestDelayMs: 500,
                // ping berkala biar koneksi gak di-drop diam-diam sama server/network
                // sebelum kita sempat tau. Tanpa ini, socket bisa "mati" tapi status
                // masih ke-anggep "open" sampai ada request berikutnya yang gagal.
                keepAliveIntervalMs: 25000,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                emitOwnEvents: false,
            });

            sock.ev.on("creds.update", saveCreds);

            // isPairing: true selama BELUM PERNAH open sama sekali. Selama flag ini
            // true, close-code yang mirip "logout" (401/403/connectionReplaced) TIDAK
            // dianggap logout beneran — soalnya WhatsApp emang sering ngirim close-code
            // begituan pas fase awal pairing, padahal itu bagian normal dari handshake.
            waClients.set(key, { sock, status: "connecting", reconnecting: false, isPairing: true });

            sock.waitForOpen = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error("Timeout menunggu koneksi WhatsApp"));
                }, 60000);

                sock.ev.on("connection.update", (update) => {
                    if (update.connection === "open") {
                        clearTimeout(timeout);
                        resolve(true);
                    }
                    if (update.connection === "close") {
                        clearTimeout(timeout);
                        reject(new Error("Koneksi WhatsApp tertutup"));
                    }
                });
            });
            sock.waitForOpen.catch(() => {});

            sock.ev.on("connection.update", async (update) => {
                try {
                    const { connection, lastDisconnect } = update || {};
                    const client = waClients.get(key);

                    if (connection === "close") {
                        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                        if (client) client.status = "closed";

                        if (reason === DisconnectReason.restartRequired) {
                            log.info(`Restart koneksi (normal, bagian dari pairing) | ${tag(uid, number)}`);
                            initializingKeys.delete(key);
                            initWhatsappForNumber(bot, uid, number, 0, notifyTo).catch((err) => {
                                log.error(`Restart koneksi gagal | ${tag(uid, number)} | ${err.message}`);
                            });
                            return;
                        }

                        const isFatalReason =
                            reason === DisconnectReason.loggedOut ||
                            reason === DisconnectReason.connectionReplaced ||
                            reason === DisconnectReason.badSession ||
                            reason === DisconnectReason.multideviceMismatch ||
                            reason === 401 ||
                            reason === 403;

                        // selama masih fase pairing awal, JANGAN treat sebagai fatal —
                        // reconnect biasa aja, kasih kesempatan handshake kelar dulu
                        if (isFatalReason && !client?.isPairing) {
                            log.error(`Logout / Banned / Diganti sesi lain, session dihapus otomatis | ${tag(uid, number)}`);

                            await deleteSessionFiles(uid, number);
                            removePairNumber(String(uid), number);
                            waClients.delete(key);
                            initializingKeys.delete(key);

                            await notifyOwner(bot, `Nomor \`${number}\` (key \`${uid}\`) logout/banned/diganti sesi lain (reason: ${reason}). Sesi otomatis dihapus.`);

                            try {
                                await bot.api.sendMessage(
                                    notifyTo,
                                    `🚫 *WhatsApp terputus*\nNomor ${number} logout/banned, sesi otomatis dihapus.`,
                                    { parse_mode: "Markdown" }
                                );
                            } catch {}
                            return;
                        }

                        if (isFatalReason && client?.isPairing) {
                            log.warning(`Close code mirip logout (${reason}) tapi masih fase pairing, dianggap normal & reconnect | ${tag(uid, number)}`);
                        }

                        if (client && !client.reconnecting && retryCount < MAX_RETRIES) {
                            client.reconnecting = true;
                            const delay = getReconnectDelay(retryCount);
                            log.warning(`Terputus (reason: ${reason}), reconnecting dalam ${Math.round(delay / 1000)}s (${retryCount + 1}/${MAX_RETRIES})... | ${tag(uid, number)}`);

                            setTimeout(() => {
                                const c = waClients.get(key);
                                if (c) c.reconnecting = false;
                                initializingKeys.delete(key);
                                initWhatsappForNumber(bot, uid, number, retryCount + 1, notifyTo).catch((err) => {
                                    log.error(`Reconnect gagal | ${tag(uid, number)} | ${err.message}`);
                                });
                            }, delay);

                        } else if (retryCount >= MAX_RETRIES) {
                            log.error(`Gagal reconnect setelah ${MAX_RETRIES}x, session dihapus | ${tag(uid, number)}`);

                            await deleteSessionFiles(uid, number);
                            removePairNumber(String(uid), number);
                            waClients.delete(key);
                            initializingKeys.delete(key);

                            await notifyOwner(bot, `Nomor \`${number}\` (key \`${uid}\`) gagal reconnect setelah ${MAX_RETRIES}x. Sesi dihapus.`);

                            try {
                                await bot.api.sendMessage(
                                    notifyTo,
                                    `🚫 *Sesi dihapus otomatis*\nGagal reconnect nomor ${number} setelah ${MAX_RETRIES} percobaan.`,
                                    { parse_mode: "Markdown" }
                                );
                            } catch {}
                        }
                    } else if (connection === "open") {
                        if (client) {
                            client.status = "open";
                            client.isPairing = false;
                            client.reconnecting = false;
                        }
                        initializingKeys.delete(key);
                        log.success(`WhatsApp terhubung! | ${tag(uid, number)}`);
                    }
                } catch (err) {
                    log.error(`Error internal connection.update | ${tag(uid, number)} | ${err.message}`);
                    await notifyOwner(bot, `Error internal di handler koneksi\n${tag(uid, number)}\n\n\`${err.message}\``);
                }
            });

            return sock;

        } finally {
            // FIX: sebelumnya ada bug operator precedence di sini
            // (`!x === "open"` selalu false, jadi baris ini gak pernah jalan sama
            // sekali dan bikin initializingKeys nyangkut -> race -> socket dobel ->
            // WhatsApp nutup salah satu sebagai "connectionReplaced" -> session
            // kehapus padahal gak ada yang beneran logout).
            setTimeout(() => {
                if (waClients.get(key)?.status !== "open") {
                    initializingKeys.delete(key);
                }
            }, 5000);
        }
    }


// ----------- ( fungsi: waitForPairSuccess, khusus dipakai flow /pair ) ------------ //

    export function waitForPairSuccess(uid, number, timeoutMs = 100000) {
        return new Promise((resolve, reject) => {
            const key = clientKey(uid, number);
            const start = Date.now();

            const interval = setInterval(() => {
                const client = waClients.get(key);

                if (client?.status === "open") {
                    clearInterval(interval);
                    resolve(true);
                    return;
                }

                if (!client) {
                    clearInterval(interval);
                    reject(new Error("Pairing gagal, sesi dihapus (kemungkinan logout/banned)"));
                    return;
                }

                if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    reject(new Error("Timeout menunggu WhatsApp terhubung"));
                }
            }, 1000);
        });
    }


// ----------- ( fungsi: loadAllWhatsappSessions, restore sesi bot UTAMA pas startup ) ------------ //

    export async function loadAllWhatsappSessions(bot) {
        log.loading("Memulai restore semua session WhatsApp (bot utama)...");

        if (!fs.existsSync(SESSION_ROOT)) {
            log.warning("Folder session tidak ditemukan, tidak ada yang di-restore.");
            return;
        }

        const userIds = (await fs.promises.readdir(SESSION_ROOT)).filter((uid) =>
            fs.statSync(path.join(SESSION_ROOT, uid)).isDirectory() && !uid.startsWith("sub_")
        );

        if (!userIds.length) {
            log.warning("Folder session kosong, tidak ada yang di-restore.");
            return;
        }

        let successCount = 0;
        let failedCount = 0;

        for (const uid of userIds) {
            const userPath = path.join(SESSION_ROOT, uid);
            const numbers = (await fs.promises.readdir(userPath)).filter((num) =>
                fs.statSync(path.join(userPath, num)).isDirectory()
            );

            if (!numbers.length) continue;

            log.info(`User ${uid} — ditemukan ${numbers.length} session tersimpan`);

            for (const number of numbers) {
                try {
                    log.loading(`Restore session... | ${tag(uid, number)}`);
                    await initWhatsappForNumber(bot, uid, number);
                    successCount++;
                    await new Promise((r) => setTimeout(r, 800));
                } catch (err) {
                    failedCount++;
                    log.error(`Gagal restore | ${tag(uid, number)} | ${err.message}`);
                    await notifyOwner(bot, `Gagal restore sesi\n${tag(uid, number)}\n\n\`${err.message}\``);
                }
            }
        }

        log.success(`Restore bot utama selesai — 🟢 ${successCount} berhasil, 🔴 ${failedCount} gagal`);
    }


// ----------- ( fungsi: restoreSessionsForKey, khusus 1 key tertentu ) ------------ //

    export async function restoreSessionsForKey(bot, sessionKey, notifyTarget = null) {
        const userPath = path.join(SESSION_ROOT, String(sessionKey));
        if (!fs.existsSync(userPath)) return;

        const numbers = (await fs.promises.readdir(userPath)).filter((num) =>
            fs.statSync(path.join(userPath, num)).isDirectory()
        );

        if (!numbers.length) return;

        log.info(`Restore shared session buat key ${sessionKey} — ditemukan ${numbers.length} nomor`);

        for (const number of numbers) {
            try {
                log.loading(`Restore shared session... | ${tag(sessionKey, number)}`);
                await initWhatsappForNumber(bot, sessionKey, number, 0, notifyTarget);
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                log.error(`Gagal restore shared session | ${tag(sessionKey, number)} | ${err.message}`);
            }
        }
    }


// ----------- ( fungsi: waitForConnection, backward-compat ) ------------ //

    export function waitForConnection(sock, timeout = 90000) {
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                reject(new Error("Timeout menunggu WhatsApp terhubung"));
            }, timeout);

            const handler = (update) => {
                const { connection } = update;

                if (connection === "open") {
                    clearTimeout(timer);
                    sock.ev.off("connection.update", handler);
                    resolve(true);
                }

                if (connection === "close") {
                    clearTimeout(timer);
                    sock.ev.off("connection.update", handler);
                    reject(new Error("Pairing gagal, koneksi tertutup"));
                }
            };

            sock.ev.on("connection.update", handler);
        });
    }


// ----------- ( fungsi: endWhatsappForNumber, hapus 1 sesi ) ------------ //

    export async function endWhatsappForNumber(uid, number) {
        const key = clientKey(uid, number);
        const client = waClients.get(key);

        log.warning(`Menghapus session... | ${tag(uid, number)}`);

        try {
            if (client?.sock?.end) await client.sock.end();
        } catch {}

        waClients.delete(key);
        initializingKeys.delete(key);
        await deleteSessionFiles(uid, number);

        log.success(`Session berhasil dihapus | ${tag(uid, number)}`);
    }


// ----------- ( fungsi: clearAllSessions, hapus semua sesi ) ------------ //

    export async function clearAllSessions() {
        const total = waClients.size;
        log.warning(`Menghapus SEMUA session WhatsApp (${total} aktif)...`);

        for (const key of [...waClients.keys()]) {
            const client = waClients.get(key);
            try {
                if (client?.sock?.end) await client.sock.end();
            } catch {}
            waClients.delete(key);
            initializingKeys.delete(key);
        }

        try {
            await fs.promises.rm(SESSION_ROOT, { recursive: true, force: true });
            fs.mkdirSync(SESSION_ROOT, { recursive: true });
            log.success(`Semua session (${total}) berhasil dihapus.`);
        } catch (err) {
            log.error(`Gagal membersihkan folder session: ${err.message}`);
        }
    }