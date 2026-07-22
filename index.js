import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { BOT_TOKEN, OWNER_ID } from "./setting/config.js";
import { log } from "./path/logger.js";
import { registerBotHandlers } from "./path/handlers.js";
import { restoreDeployedBots } from "./path/deploy.js";
import { loadAllWhatsappSessions } from "./path/whatsapp.js";
import { getUsers } from "./database.js";

const bot = new Bot(BOT_TOKEN);


// ----------- ( fungsi: notifyOwnerCrash, laporan darurat via Telegram ) ------------ //

    async function notifyOwnerCrash(label, err) {
        const detail = err?.stack || err?.message || String(err);
        log.error(`${label}: ${detail}`);

        if (!OWNER_ID) return;
        try {
            await bot.api.sendMessage(
                OWNER_ID,
                `🚨 *${label}*\n\n\`\`\`\n${detail.slice(0, 3000)}\n\`\`\``,
                { parse_mode: "Markdown" }
            );
        } catch {}
    }


// ----------- ( GLOBAL SAFETY NET: bot gak boleh mati gara-gara error liar ) ------------ //

    process.on("unhandledRejection", (reason) => {
        notifyOwnerCrash("UNHANDLED REJECTION", reason);
    });

    process.on("uncaughtException", (err) => {
        notifyOwnerCrash("UNCAUGHT EXCEPTION", err);
    });


// ----------- ( fungsi: load user pas startup ) ------------ //

    function loadUsersOnStartup() {
        const users = getUsers();
        log.success(`${users.length} user berhasil dimuat dari database`);
        return users;
    }


// ----------- ( daftarin command ke bot utama, isSubBot: false ) ------------ //

    registerBotHandlers(bot, { isSubBot: false });


// ----------- ( start bot utama PAKAI RUNNER (konkuren) + restore sesi ) ------------ //
// PENTING: bot.start() bawaan grammY itu SEKUENSIAL — 1 command lama (misal /pair
// yang nunggu 90 detik) bakal nge-block SEMUA user lain sampai selesai.
// run() dari @grammyjs/runner proses banyak update SEKALIGUS, jadi user lain
// tetap bisa dilayani meskipun ada proses panjang yang lagi jalan.

    const runner = run(bot);

log.success("SHOYU BOT (utama) berhasil terhubung ke Telegram (mode konkuren)");

(async () => {
    try {
        await loadAllWhatsappSessions(bot);
        await loadUsersOnStartup();
        await restoreDeployedBots();
    } catch (err) {
        log.error(err);
    }
})();

log.whatsapp("SHOYU BOT siap digunakan 🚀");


// ----------- ( graceful shutdown, biar runner berhenti bersih ) ------------ //

    const stopRunner = () => {
        if (runner.isRunning()) {
            log.warning("Menghentikan bot utama...");
            runner.stop();
        }
    };

    process.once("SIGINT", stopRunner);
    process.once("SIGTERM", stopRunner);
