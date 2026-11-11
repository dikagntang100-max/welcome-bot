
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const bot = new Telegraf(process.env.BOT_TOKEN);

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SECRET = process.env.WEBHOOK_SECRET;

async function saveGroup(chat) {
  await db.from("telegram_groups").upsert({
    group_id: String(chat.id),
    group_name: chat.title || "Telegram Group",
    active: true
  }, { onConflict: "group_id" });
}

async function getGroup(groupId) {
  const { data } = await db
    .from("telegram_groups")
    .select("*")
    .eq("group_id", String(groupId))
    .maybeSingle();

  return data;
}

async function isAdmin(ctx, groupId, userId) {
  try {
    const member = await ctx.telegram.getChatMember(
      groupId,
      userId
    );

    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

async function setSetting(groupId, key, value) {
  return db.from("telegram_settings").upsert({
    group_id: String(groupId),
    setting_key: key,
    setting_value: String(value)
  }, { onConflict: "group_id,setting_key" });
}

async function getSetting(groupId, key, fallback = "") {
  const { data } = await db
    .from("telegram_settings")
    .select("setting_value")
    .eq("group_id", String(groupId))
    .eq("setting_key", key)
    .maybeSingle();

  return data?.setting_value ?? fallback;
}

function formatText(text, user, group) {
  const name = user.first_name || "Member";
  const username = user.username
    ? "@" + user.username
    : name;

  return text
    .replaceAll("{name}", name)
    .replaceAll("{username}", username)
    .replaceAll("{id}", String(user.id))
    .replaceAll("{group}", group.title || "Group");
}

async function groupMenu(ctx, groupId) {
  const group = await getGroup(groupId);

  if (!group) {
    return ctx.reply("Grup belum terdaftar. Tambahkan bot ke grup terlebih dahulu.");
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("Welcome ON/OFF", `toggle_welcome:${groupId}`)
    ],
    [
      Markup.button.callback("Ubah teks welcome", `edit_welcome:${groupId}`)
    ],
    [
      Markup.button.callback("Leave ON/OFF", `toggle_leave:${groupId}`)
    ],
    [
      Markup.button.callback("Ubah teks leave", `edit_leave:${groupId}`)
    ],
    [
      Markup.button.callback("Panduan Pin", `pin_help:${groupId}`),
      Markup.button.callback("Panduan Tag All", `tag_help:${groupId}`)
    ],
    [
      Markup.button.callback("Kembali", "home")
    ]
  ]);

  await ctx.reply(
    `⚙️ PENGATURAN GRUP\n\nNama: ${group.group_name}\nID: ${group.group_id}`,
    keyboard
  );
}

bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const { data: groups } = await db
    .from("telegram_groups")
    .select("group_id,group_name")
    .eq("active", true);

  const buttons = [];

  for (const group of groups || []) {
    if (await isAdmin(ctx, group.group_id, ctx.from.id)) {
      buttons.push([
        Markup.button.callback(
          group.group_name,
          `select:${group.group_id}`
        )
      ]);
    }
  }

  if (!buttons.length) {
    return ctx.reply(
      "👋 Selamat datang di MAWZZ WELCOME BOT PUBLIC!\n\n" +
      "Tambahkan bot ke grup kamu, jadikan bot sebagai admin, " +
      "lalu buka /start kembali untuk mengatur grup."
    );
  }

  return ctx.reply(
    "👋 MAWZZ WELCOME BOT PUBLIC\n\nPilih grup yang ingin kamu atur:",
    Markup.inlineKeyboard(buttons)
  );
});

bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  return ctx.reply("Ketik /start untuk memilih grup.");
});

bot.action(/^select:(-?\d+)$/, async (ctx) => {
  const groupId = ctx.match[1];

  if (!(await isAdmin(ctx, groupId, ctx.from.id))) {
    return ctx.answerCbQuery("Khusus admin grup!", { show_alert: true });
  }

  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  return groupMenu(ctx, groupId);
});

bot.action(/^(toggle_welcome|toggle_leave):(-?\d+)$/, async (ctx) => {
  const action = ctx.match[1];
  const groupId = ctx.match[2];

  if (!(await isAdmin(ctx, groupId, ctx.from.id))) {
    return ctx.answerCbQuery("Khusus admin grup!", { show_alert: true });
  }

  const group = await getGroup(groupId);
  if (!group) return ctx.answerCbQuery("Grup tidak ditemukan.");

  const column = action === "toggle_welcome"
    ? "welcome_enabled"
    : "leave_enabled";

  const next = !group[column];

  await db.from("telegram_groups")
    .update({ [column]: next })
    .eq("group_id", groupId);

  await ctx.answerCbQuery(next ? "Berhasil diaktifkan!" : "Berhasil dimatikan!");
  await ctx.deleteMessage().catch(() => {});
  return groupMenu(ctx, groupId);
});

bot.action(/^(edit_welcome|edit_leave):(-?\d+)$/, async (ctx) => {
  const type = ctx.match[1] === "edit_welcome" ? "welcome" : "leave";
  const groupId = ctx.match[2];

  if (!(await isAdmin(ctx, groupId, ctx.from.id))) {
    return ctx.answerCbQuery("Khusus admin grup!", { show_alert: true });
  }

  await setSetting(groupId, `pending_${ctx.from.id}`, type);

  await ctx.answerCbQuery();
  return ctx.reply(
    `Kirim teks ${type} baru untuk grup ini.\n\n` +
    "Variabel yang tersedia:\n" +
    "{name} = Nama member\n" +
    "{username} = Username\n" +
    "{id} = ID member\n" +
    "{group} = Nama grup\n\n" +
    "Ketik /cancel untuk membatalkan."
  );
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const { data: groups } = await db
    .from("telegram_groups")
    .select("group_id");

  for (const group of groups || []) {
    await db.from("telegram_settings")
      .delete()
      .eq("group_id", group.group_id)
      .eq("setting_key", `pending_${ctx.from.id}`);
  }

  return ctx.reply("Pengaturan dibatalkan.");
});

bot.action(/^pin_help:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    "📌 CARA PIN PESAN\n\n" +
    "Balas pesan yang ingin dipin, lalu ketik /pin di grup."
  );
});

bot.action(/^tag_help:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    "📢 CARA TAG ALL\n\n" +
    "Ketik /tagall di grup untuk menyebut member yang pernah terdeteksi bot.\n\n" +
    "Catatan: Telegram tidak mengizinkan bot mengambil seluruh daftar anggota grup secara bebas."
  );
});

bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  const status = ctx.update.my_chat_member.new_chat_member.status;

  if (!["group", "supergroup"].includes(chat.type)) return;

  if (["member", "administrator"].includes(status)) {
    await saveGroup(chat);
  } else if (["left", "kicked"].includes(status)) {
    await db.from("telegram_groups")
      .update({ active: false })
      .eq("group_id", String(chat.id));
  }
});

bot.on("new_chat_members", async (ctx) => {
  const group = ctx.chat;
  await saveGroup(group);

  const settings = await getGroup(group.id);
  if (!settings?.welcome_enabled) return;

  for (const user of ctx.message.new_chat_members) {
    if (user.is_bot) continue;

    await db.from("telegram_members").upsert({
      group_id: String(group.id),
      user_id: String(user.id),
      first_name: user.first_name,
      username: user.username || null,
      last_seen: new Date().toISOString()
    }, { onConflict: "group_id,user_id" });

    const message = formatText(
      settings.welcome_text,
      user,
      group
    );

    await ctx.reply(message);
  }
});

bot.on("left_chat_member", async (ctx) => {
  const group = ctx.chat;
  const user = ctx.message.left_chat_member;

  const settings = await getGroup(group.id);

  await db.from("telegram_members")
    .delete()
    .eq("group_id", String(group.id))
    .eq("user_id", String(user.id));

  if (!settings?.leave_enabled || user.is_bot) return;

  await ctx.reply(
    formatText(settings.leave_text, user, group)
  );
});

bot.on("message", async (ctx) => {
  const message = ctx.message;

  if (ctx.chat.type === "private") {
    if (!message.text || message.text.startsWith("/")) return;

    const { data: groups } = await db
      .from("telegram_groups")
      .select("group_id");

    for (const group of groups || []) {
      const key = `pending_${ctx.from.id}`;

      const { data } = await db.from("telegram_settings")
        .select("setting_value")
        .eq("group_id", group.group_id)
        .eq("setting_key", key)
        .maybeSingle();

      if (!data) continue;

      if (!(await isAdmin(ctx, group.group_id, ctx.from.id))) {
        await db.from("telegram_settings")
          .delete()
          .eq("group_id", group.group_id)
          .eq("setting_key", key);
        continue;
      }

      const type = data.setting_value;
      const column = type === "welcome" ? "welcome_text" : "leave_text";

      await db.from("telegram_groups")
        .update({ [column]: message.text })
        .eq("group_id", group.group_id);

      await db.from("telegram_settings")
        .delete()
        .eq("group_id", group.group_id)
        .eq("setting_key", key);

      return ctx.reply(`✅ Teks ${type} berhasil diperbarui!`);
    }

    return;
  }

  if (!["group", "supergroup"].includes(ctx.chat.type)) return;

  await saveGroup(ctx.chat);

  if (message.from && !message.from.is_bot) {
    await db.from("telegram_members").upsert({
      group_id: String(ctx.chat.id),
      user_id: String(message.from.id),
      first_name: message.from.first_name,
      username: message.from.username || null,
      last_seen: new Date().toISOString()
    }, { onConflict: "group_id,user_id" });
  }
});

bot.command("pin", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat.type)) return;

  if (!(await isAdmin(ctx, ctx.chat.id, ctx.from.id))) {
    return ctx.reply("Hanya admin grup yang bisa menggunakan perintah ini.");
  }

  if (!ctx.message.reply_to_message) {
    return ctx.reply("Balas pesan yang ingin dipin, lalu ketik /pin.");
  }

  try {
    await ctx.telegram.pinChatMessage(
      ctx.chat.id,
      ctx.message.reply_to_message.message_id
    );
    return ctx.reply("📌 Pesan berhasil dipin!");
  } catch {
    return ctx.reply("Gagal pin. Pastikan bot punya izin pin pesan.");
  }
});

bot.command("tagall", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat.type)) return;

  if (!(await isAdmin(ctx, ctx.chat.id, ctx.from.id))) {
    return ctx.reply("Hanya admin grup yang bisa menggunakan perintah ini.");
  }

  const groupId = String(ctx.chat.id);
  const settings = await getGroup(groupId);

  if (!settings?.tagall_enabled) {
    return ctx.reply("Fitur Tag All sedang dimatikan.");
  }

  const { data: cooldown } = await db
    .from("telegram_tagall_cooldowns")
    .select("last_used")
    .eq("group_id", groupId)
    .maybeSingle();

  if (
    cooldown &&
    Date.now() - new Date(cooldown.last_used).getTime() < 60000
  ) {
    return ctx.reply("Tunggu 60 detik sebelum menggunakan Tag All lagi.");
  }

  await db.from("telegram_tagall_cooldowns").upsert({
    group_id: groupId,
    last_used: new Date().toISOString()
  }, { onConflict: "group_id" });

  const { data: members } = await db
    .from("telegram_members")
    .select("user_id,first_name")
    .eq("group_id", groupId)
    .limit(30);

  if (!members?.length) {
    return ctx.reply("Belum ada member yang terdeteksi bot.");
  }

  const customText = ctx.message.text.replace(/^\/tagall(@\w+)?\s*/i, "");
  const mentions = members.map(member => {
    const name = (member.first_name || "Member")
      .replace(/[<>&]/g, "");
    return `<a href="tg://user?id=${member.user_id}">${name}</a>`;
  });

  const chunks = [];
  for (let i = 0; i < mentions.length; i += 10) {
    chunks.push(mentions.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    await ctx.reply(
      `${customText ? customText + "\n" : ""}${chunk.join(" ")}`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  }
});

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("MAWZZ WELCOME BOT ACTIVE");
  }

  if (
    SECRET &&
    req.headers["x-telegram-bot-api-secret-token"] !== SECRET
  ) {
    return res.status(403).send("Forbidden");
  }

  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(200).send("OK");
  }
};
