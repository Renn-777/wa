import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { log } from "./logger.js";
import { getAllBotsRaw, removeBotEntry } from "../database.js";
import { registerBotHandlers } from "./handlers.js";
import { sharedSessionKeyFromToken, restoreSessionsForKey } from "./whatsapp.js";

// key = token -> { bot: instance Bot, handle: runner handle }
export const deployedBots = new Map();


// ----------- ( fungsi: startDeployedBot ) ------------ //

    export async function startDeployedBot(token, ownerId, deployerUid) {
        if (deployedBots.has(token)) {
            return deployedBots.get(token).bot;
        }

        const subBot = new Bot(token);

        registerBotHandlers(subBot, {
            isSubBot: true,
            subBotOwnerId: String(ownerId),
            subBotToken: token,
        });

        subBot.catch((err) => {
            log.error(`Sub-bot error (...${token.slice(-6)}): ${err.message}`);
        });

        await subBot.init();

        // PENTING: pakai run() (bukan subBot.start()) biar sub-bot ini juga
        // proses update secara KONKUREN. Kalau pakai .start() biasa, 1 user yang
        // lagi nunggu /pair bakal nge-block semua user lain di sub-bot yang sama.
        const handle = run(subBot);

        deployedBots.set(token, { bot: subBot, handle });
        log.success(`Sub-bot aktif (mode konkuren) | Owner: ${ownerId} | Deployer: ${deployerUid}`);

        // restore session WA yang SHARED khusus punya sub-bot ini,
        // pakai instance subBot sendiri biar notif logout nyampe ke ownerId lewat bot yang benar
        const sessionKey = sharedSessionKeyFromToken(token);
        await restoreSessionsForKey(subBot, sessionKey, ownerId);

        return subBot;
    }


// ----------- ( fungsi: stopDeployedBot ) ------------ //

    export async function stopDeployedBot(token) {
        const entry = deployedBots.get(token);
        if (!entry) return false;

        try {
            if (entry.handle?.isRunning?.()) {
                await entry.handle.stop();
            }
        } catch {}

        deployedBots.delete(token);
        log.warning(`Sub-bot dihentikan (...${token.slice(-6)})`);
        return true;
    }


// ----------- ( fungsi: restoreDeployedBots, dipanggil pas startup ) ------------ //

    export async function restoreDeployedBots() {
        const all = getAllBotsRaw();
        const entries = Object.entries(all);

        if (!entries.length) {
            log.warning("Belum ada bot ter-deploy, skip restore.");
            return;
        }

        let success = 0;
        let failed = 0;

        for (const [deployerUid, bots] of entries) {
            for (const b of bots) {
                try {
                    await startDeployedBot(b.token, b.ownerId, deployerUid);
                    success++;
                } catch (err) {
                    failed++;
                    log.error(`Restore sub-bot gagal (...${b.token.slice(-6)}): ${err.message}`);

                    if (err.message?.includes("404") || err.message?.includes("Not Found")) {
                        removeBotEntry(deployerUid, b.token);
                        log.warning(`Token invalid dihapus otomatis (...${b.token.slice(-6)})`);
                    }
                }
            }
        }

        log.success(`Restore sub-bot selesai — 🟢 ${success} berhasil, 🔴 ${failed} gagal`);
    }
