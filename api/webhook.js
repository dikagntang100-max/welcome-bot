
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const bot = new Telegraf(process.env.BOT_TOKEN);

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SECRET = process.env.WEBHOOK_SECRET;

const isGroup = chat =>
  chat && ["group", "supergroup"].includes(chat.type);

const esc = s => String(s || "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;",
  '"': "&quot;", "'": "&#39;"
})[c]);

async function admin(chatId, userId) {
  try {
    const m = await bot.telegram.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(m.status);
  } catch {
    return false;
  }
}

async function saveGroup(chat) {
  await db.from("bot_groups").upsert({
    chat_id: chat.id,
    title: chat.title || "Telegram Group",
    active: true
  }, { onConflict: "chat_id" });
}

async function getGroup(id) {
  const { data } = await db.from("bot_groups")
    .select("*").eq("chat_id", id)
    .eq("active", true).maybeSingle();
  return data;
}

async function saveMember(chatId, user) {
  if (!user || user.is_bot) return;

  await db.from("bot_group_members").upsert({
    chat_id: chatId,
    user_id: user.id,
    first_name: user.first_name || "Member",
    username: user.username || null,
    is_bot: false,
    last_seen_at: new Date().toISOString()
  }, { onConflict: "chat_id,user_id" });
}

function formatText(template, user, group) {
  return String(template || "")
    .replace(/\{name\}/gi, user.first_name || "Member")
    .replace(/\{username\}/gi, user.username ? "@" + user.username : user.first_name || "Member")
    .replace(/\{id\}/gi, String(user.id))
    .replace(/\{group\}/gi, group.title || "Grup");
}

async function showGroups(ctx, edit = false) {
  const { data } = await db.from("bot_groups")
    .select("chat_id,title")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(100);

  const buttons = [];

  for (const g of data || []) {
    if (await admin(g.chat_id, ctx.from.id)) {
      buttons.push([
        Markup.button.callback(
          "📁 " + g.title.slice(0, 40),
          "group:" + g.chat_id
        )
      ]);
    }
  }

  const text =
    "👋 MAWZZ WELCOME BOT\n\n" +
    "Pilih grup yang ingin kamu atur.";

  if (!buttons.length) {
    const empty =
      "👋 MAWZZ WELCOME BOT\n\n" +
      "Belum ada grup yang bisa dikelola.\n\n" +
      "1. Masukkan bot ke grup.\n" +
      "2. Jadikan bot admin.\n" +
      "3. Kamu juga harus admin grup.\n" +
      "4. Tekan refresh.";

    if (edit) return ctx.editMessageText(empty).catch(() => {});
    return ctx.reply(empty);
  }

  buttons.push([
    Markup.button.callback("🔄 Refresh", "refresh")
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (edit) {
    return ctx.editMessageText(text, keyboard).catch(() => {});
  }
  return ctx.reply(text, keyboard);
}

async function showMenu(ctx, id) {
  if (!(await admin(id, ctx.from.id))) {
    return ctx.answerCbQuery("Khusus admin grup!", { show_alert: true });
  }

  const g = await getGroup(id);
  if (!g) return ctx.answerCbQuery("Grup tidak ditemukan.");

  const text =
    "⚙️ PENGATURAN GRUP\n\n" +
    "📁 " + g.title + "\n" +
    "👋 Sambutan: " + (g.welcome_enabled ? "Aktif ✅" : "Mati ❌") + "\n" +
    "🚪 Pesan keluar: " + (g.leave_enabled ? "Aktif ✅" : "Mati ❌");

  return ctx.editMessageText(text, Markup.inlineKeyboard([
    [Markup.button.callback(
      g.welcome_enabled ? "🔴 Matikan Sambutan" : "🟢 Aktifkan Sambutan",
      "toggle_w:" + id
    )],
    [Markup.button.callback("✏️ Ubah Sambutan", "edit_w:" + id)],
    [Markup.button.callback(
      g.leave_enabled ? "🔴 Matikan Pesan Keluar" : "🟢 Aktifkan Pesan Keluar",
      "toggle_l:" + id
    )],
    [Markup.button.callback("✏️ Ubah Pesan Keluar", "edit_l:" + id)],
    [Markup.button.callback("📌 Panduan Pin", "pin_help")],
    [Markup.button.callback("📢 Panduan Tag All", "tag_help")],
    [Markup.button.callback("⬅️ Pilih Grup", "refresh")]
  ])).catch(() => {});
}

async function setSession(userId, chatId, action) {
  await db.from("bot_sessions").upsert({
    user_id: userId,
    chat_id: chatId,
    action,
    expires_at: new Date(Date.now() + 600000).toISOString()
  }, { onConflict: "user_id" });
}

bot.start(async ctx => {
  if (ctx.chat.type === "private") return showGroups(ctx);
  return ctx.reply("✅ Bot aktif! Buka Private Chat bot dan ketik /start.");
});

bot.action("refresh", async ctx => {
  await ctx.answerCbQuery();
  return showGroups(ctx, true);
});

bot.action(/^group:(-?\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  return showMenu(ctx, Number(ctx.match[1]));
});

bot.action(/^toggle_w:(-?\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  if (!(await admin(id, ctx.from.id))) return ctx.answerCbQuery("Akses ditolak!");

  const g = await getGroup(id);
  if (!g) return ctx.answerCbQuery("Grup tidak ditemukan.");

  await db.from("bot_groups")
    .update({ welcome_enabled: !g.welcome_enabled })
    .eq("chat_id", id);

  await ctx.answerCbQuery("Berhasil diperbarui!");
  return showMenu(ctx, id);
});

bot.action(/^toggle_l:(-?\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  if (!(await admin(id, ctx.from.id))) return ctx.answerCbQuery("Akses ditolak!");

  const g = await getGroup(id);
  if (!g) return ctx.answerCbQuery("Grup tidak ditemukan.");

  await db.from("bot_groups")
    .update({ leave_enabled: !g.leave_enabled })
    .eq("chat_id", id);

  await ctx.answerCbQuery("Berhasil diperbarui!");
  return showMenu(ctx, id);
});

bot.action(/^edit_w:(-?\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  if (!(await admin(id, ctx.from.id))) return ctx.answerCbQuery("Akses ditolak!");

  await setSession(ctx.from.id, id, "welcome");
  await ctx.answerCbQuery();

  return ctx.reply(
    "✏️ Kirim kata sambutan baru.\n\n" +
    "Variabel:\n{name} = Nama member\n{username} = Username\n{id} = ID\n{group} = Nama grup\n\n" +
    "Ketik /cancel untuk batal."
  );
});

bot.action(/^edit_l:(-?\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  if (!(await admin(id, ctx.from.id))) return ctx.answerCbQuery("Akses ditolak!");

  await setSession(ctx.from.id, id, "leave");
  await ctx.answerCbQuery();

  return ctx.reply(
    "✏️ Kirim kata pesan keluar baru.\n\n" +
    "Variabel: {name}, {username}, {id}, {group}\n\n" +
    "Ketik /cancel untuk batal."
  );
});

bot.action("pin_help", async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply("📌 Balas pesan grup yang ingin disematkan, lalu ketik /pin.");
});

bot.action("tag_help", async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply("📢 Gunakan /tagall Pesan kamu di grup. Hanya admin grup yang bisa.");
});

bot.command("cancel", async ctx => {
  if (ctx.chat.type !== "private") return;
  await db.from("bot_sessions").delete().eq("user_id", ctx.from.id);
  return ctx.reply("❌ Dibatalkan. Ketik /start untuk kembali.");
});

bot.command("pin", async ctx => {
  if (!isGroup(ctx.chat)) return ctx.reply("Gunakan di grup.");
  if (!(await admin(ctx.chat.id, ctx.from.id))) {
    return ctx.reply("❌ Khusus admin grup.");
  }

  const target = ctx.message.reply_to_message;
  if (!target) return ctx.reply("Balas pesan yang ingin dipin, lalu ketik /pin.");

  try {
    await ctx.telegram.pinChatMessage(ctx.chat.id, target.message_id, {
      disable_notification: true
    });
    return ctx.reply("📌 Pesan berhasil disematkan!");
  } catch {
    return ctx.reply("❌ Bot belum punya izin pin pesan.");
  }
});

bot.command("tagall", async ctx => {
  if (!isGroup(ctx.chat)) return ctx.reply("Gunakan di grup.");
  if (!(await admin(ctx.chat.id, ctx.from.id))) {
    return ctx.reply("❌ Khusus admin grup.");
  }

  const g = await getGroup(ctx.chat.id);
  if (!g) return ctx.reply("Grup belum terdaftar.");

  if (g.last_tag_at &&
      Date.now() - new Date(g.last_tag_at).getTime() < 30000) {
    return ctx.reply("⏳ Tunggu 30 detik sebelum tagall lagi.");
  }

  await db.from("bot_groups")
    .update({ last_tag_at: new Date().toISOString() })
    .eq("chat_id", ctx.chat.id);

  const message = ctx.message.text
    .replace(/^\/tagall(?:@\w+)?\s*/i, "").trim();

  const { data: members } = await db.from("bot_group_members")
    .select("user_id,first_name")
    .eq("chat_id", ctx.chat.id)
    .eq("is_bot", false)
    .limit(500);

  if (!members?.length) {
    return ctx.reply("Belum ada member tercatat.");
  }

  await ctx.reply("📢 " + (message || "Halo semuanya!"));

  for (let i = 0; i < members.length; i += 10) {
    const mentions = members.slice(i, i + 10).map(m =>
      '<a href="tg://user?id=' + m.user_id + '">' +
      esc(m.first_name || "Member") + '</a>'
    );

    try {
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        mentions.join(" | "),
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error(e.message);
    }
  }
});

// BOT MASUK ATAU KELUAR GRUP
bot.on("my_chat_member", async ctx => {
  const update = ctx.myChatMember;
  if (!isGroup(update.chat)) return;

  const status = update.new_chat_member.status;

  if (["member", "administrator"].includes(status)) {
    await saveGroup(update.chat);
  } else if (["left", "kicked"].includes(status)) {
    await db.from("bot_groups")
      .update({ active: false })
      .eq("chat_id", update.chat.id);
  }
});

// SEMUA PESAN
bot.on("message", async ctx => {
  const m = ctx.message;

  // PROSES PENGATURAN PRIVATE CHAT
  if (ctx.chat.type === "private" && m.text) {
    const { data: s } = await db.from("bot_sessions")
      .select("*").eq("user_id", ctx.from.id).maybeSingle();

    if (!s) return;

    if (new Date(s.expires_at).getTime() < Date.now()) {
      await db.from("bot_sessions").delete().eq("user_id", ctx.from.id);
      return ctx.reply("Waktu pengaturan habis. Ketik /start.");
    }

    if (!(await admin(s.chat_id, ctx.from.id))) {
      await db.from("bot_sessions").delete().eq("user_id", ctx.from.id);
      return ctx.reply("❌ Akses admin tidak ditemukan.");
    }

    const value = m.text.trim();
    if (!value || value.length > 1500) {
      return ctx.reply("Teks harus 1–1500 karakter.");
    }

    const column = s.action === "welcome" ? "welcome_text" : "leave_text";

    const { error } = await db.from("bot_groups")
      .update({ [column]: value })
      .eq("chat_id", s.chat_id);

    await db.from("bot_sessions").delete().eq("user_id", ctx.from.id);

    if (error) return ctx.reply("❌ Gagal menyimpan.");

    return ctx.reply("✅ Kata-kata berhasil disimpan!");
  }

  if (!isGroup(ctx.chat)) return;

  await saveGroup(ctx.chat);

  if (m.from) await saveMember(ctx.chat.id, m.from);

  // MEMBER MASUK
  if (m.new_chat_members) {
    for (const user of m.new_chat_members) {
      if (user.is_bot) continue;

      await saveMember(ctx.chat.id, user);
      const g = await getGroup(ctx.chat.id);

      if (g && g.welcome_enabled) {
        await ctx.reply(formatText(g.welcome_text, user, g));
      }
    }
  }

  // MEMBER KELUAR
  if (m.left_chat_member) {
    const user = m.left_chat_member;

    await db.from("bot_group_members")
      .delete().eq("chat_id", ctx.chat.id)
      .eq("user_id", user.id);

    if (user.is_bot) return;

    const g = await getGroup(ctx.chat.id);

    if (g && g.leave_enabled) {
      await ctx.reply(formatText(g.leave_text, user, g));
    }
  }
});

bot.catch(err => console.error("BOT ERROR:", err.message));

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("MAWZZ WELCOME BOT ONLINE");
  }

  if (!SECRET ||
      req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    return res.status(200).send("OK");
  }
};
