require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, UserSelectMenuBuilder
} = require("discord.js");
const db = require("./db");
const { embed, hasStaff, formatPrice, safeChannelId, cleanFileName, EMBED_COLOR, EMBED_THUMB } = require("./utils");
const tickets = require("./tickets");
const ratings = require("./ratings");
const config = require("../config.json");

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel, Partials.User]
});

// ─────────── شبكة أمان: خطأ واحد لا يُسقط البوت ───────────
// الانهيارات السابقة كلها من هذا الباب: ردٌّ متأخر على تفاعل انتهت
// صلاحيته (10062 Unknown interaction) كان يرفض ب-promis غير معالَج، فيخرج
// البوت من الحياة ويصبح كل زر بعده ينتهي بـ "didn't respond in time"
// حتى يُعاد تشغيله. ماسح الضغط نفسه هو ما يصلح السبب (يعترف أولاً ثم
// يكمل وراء الاعتراف)، وهذي تضمن إن أي استثناء فاتنا يُسجَّل لا يُقتله.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
client.on("error", (err) => console.error("Client error:", err));

const pendingReviews = new Map();
// اسم وسعر المنتج بانتظار باقي خطوات الإضافة (الرتبة ← السعر ← الاسم)
const pendingProduct = new Map();

function channelFromConfig(guild, key) {
  const id = config.channels?.[key];
  return id && safeChannelId(id) ? guild.channels.cache.get(id) : null;
}

async function sendToConfiguredChannel(guild, key, payload) {
  const channel = channelFromConfig(guild, key);
  if (!channel?.isTextBased()) return false;
  await channel.send(payload);
  return true;
}

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, "..", "config.json"), JSON.stringify(config, null, 2));
}

// ─────────── اللوحة الرئيسية ───────────
function mainPanel() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:products").setLabel("Products").setEmoji("🛍️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:orders").setLabel("Orders").setEmoji("🧾").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:tickets").setLabel("Tickets").setEmoji("🎫").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:channels").setLabel("Channels").setEmoji("📌").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:content").setLabel("Messages & Embeds").setEmoji("📝").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:ratings").setLabel("Ratings").setEmoji("⭐").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:analytics").setLabel("Analytics").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:store").setLabel("Store Settings").setEmoji("🛒").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:welcome").setLabel("Welcome").setEmoji("👋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:autoroles").setLabel("Auto Roles").setEmoji("🏷️").setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:perms").setLabel("Permissions").setEmoji("🔐").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:ticket-stats").setLabel("Ticket Stats").setEmoji("📈").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:rulebook").setLabel("Rules").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Dashboard").setEmoji("🔄").setStyle(ButtonStyle.Success)
  );
  const e = embed("S2A DEV • Control Center", [
    "🛍️ **Products** — add a product and publish it to channels",
    "🧾 **Orders** — orders, payment confirmation and the log channel",
    "🎫 **Tickets** — ticket types and the panel",
    "📌 **Channels** — announcement and publishing channels",
    "📝 **Messages** — news, rules and embeds",
    "⭐ **Ratings** — the ratings system and its channel",
    "📊 **Analytics** — sales and ratings",
    "🛒 **Store Settings** — purchase and DM settings",
    "👋 **Welcome** — DM greeting, links and image",
    "🏷️ **Auto Roles** — roles granted on join",
    "🔐 **Permissions** — bot managers and staff roles",
    "📈 **Ticket Stats** — ticket statistics",
    "📜 **Rules** — the rule book: sections, banner and the published message",
  ].join("\n"));
  return { embeds: [e], components: [row1, row2, row3] };
}

// ─────────── نظام القوانين: رسالة واحدة + قائمة أقسام ───────────
// الشكل المرجعي: رسالة السيرفر فيها العنوان والمقدمة (عربي ثم إنجليزي)
// وصورة، وتحتها قائمة "اختر القسم". ضغط أي قسم يرد برسالة خاصة بقوانين
// ذلك القسم مرقّمة (1- ، 2-) عربي ثم الإنجليزي. كل النصوص في config.rules
// وتُحرَّر من داخل /panel — والملف يُزامَن مع المستودع كل دقيقتين.
function ensureRules() {
  const r = (config.rules ||= {});
  r.title ??= "Server Rules | قوانين السيرفر";
  r.image ??= "";
  r.introAr ??= "أهلاً بكم في سيرفرنا، هذه القوانين وُضعت لراحتكم وسلامتكم، يرجى القراءة والالتزام بها";
  r.introEn ??= "Welcome to our community. These rules are in place to ensure your comfort and maintain a safe, respectful environment for everyone. Please read and abide by them.";
  r.noteEn ??= "All general server rules apply to this section";
  r.noteAr ??= "جميع قوانين السيرفر العامة تنطبق على هذا القسم";
  r.channelId ??= "";
  r.messageId ??= "";
  // البذرة الأولى فقط: مصفوفة فارغة عن قصد (حذفت كل الأقسام) لا تمتلئ من جديد
  if (r.sections === undefined) {
    r.sections = [{
      id: "general",
      name: "General Rules | القوانين العامة",
      rules: [
        { ar: "احترام الآخرين: الشتائم والألفاظ البذيئة والعنصرية أو الإيحاء بها ممنوع تمامًا.", en: "Mutual Respect: Insults, slurs, racism, or hinting at them are strictly prohibited." },
        { ar: "المواضيع الحساسة: النقاشات السياسية أو الدينية غير مسموح بها.", en: "Sensitive Topics: Discussing political or religious topics is not allowed." },
        { ar: "التشهير: الإضرار بسمعة أي شخص داخل السيرفر أو خارجه ممنوع تمامًا.", en: "Defamation: Damaging the reputation of anyone, whether inside or outside the server, is strictly forbidden." },
        { ar: "الإعلانات: الترويج أو النشر أو الحديث عن سيرفرات ديسكورد أخرى ممنوع.", en: "Advertising: Promoting, sharing, or discussing other Discord servers is prohibited." },
        { ar: "المحتوى المخل: نشر أو الإيحاء بأي محتوى إباحي أو NSFW ممنوع تمامًا.", en: "NSFW Content: Sharing or hinting at pornographic/NSFW content is strictly prohibited." },
        { ar: "المضايقة: إزعاج أو مضايقة أعضاء السيرفر بأي شكل غير مسموح.", en: "Harassment: Harassing or bothering server members in any way is not allowed." },
        { ar: "الملفات الشخصية: استخدام صور أو أسماء مستخدمين أو سطور وصفية غير لائقة ممنوع.", en: "Personal Profiles: Using inappropriate or offensive profile pictures (avatars), bios, or usernames is strictly prohibited." },
        { ar: "التهرب من العقوبات: استخدام حسابات بديلة أو وهمية للتهرب من العقوبات ممنوع.", en: "Evasive Punishments: Using alternate or fake accounts to evade administrative actions (mutes or bans) is not allowed." },
      ],
    }];
  }
  if (!Array.isArray(r.sections)) r.sections = [];
  return r;
}

// قصّ النص إلى حدّ وصف الإيمبد (4096) مع علامة في النهاية لا قطع فجائي
function clip(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

// أرقام القسم: كل بند له رقم واحد يظهر في السطرين معاً (عربي وإنجليزي)
function rulesLines(sec) {
  const ar = [], en = [];
  (sec?.rules || []).forEach((line, i) => {
    if (line?.ar) ar.push(`${i + 1}- ${line.ar}`);
    if (line?.en) en.push(`${i + 1}- ${line.en}`);
  });
  return { ar, en };
}

// بطاقة القسم كما يراها العضو: عربي مرقّم ثم إنجليزي ثم تنبيه الأقسام
function rulesCardEmbed(sec) {
  const r = ensureRules();
  const { ar, en } = rulesLines(sec);
  const parts = [];
  if (ar.length) parts.push(ar.join("\n"));
  if (en.length) parts.push(en.join("\n"));
  const notes = [r.noteEn, r.noteAr].filter(Boolean);
  if (notes.length) parts.push(notes.join("\n"));
  return embed(clip(sec?.name || "Rules", 256), clip(parts.join("\n\n") || "No rules in this section yet.", 4000));
}

// ── الرسالة المنشورة: العنوان والمقدمة والصورة + قائمة الأقسام ──
function rulesPublicPayload() {
  const r = ensureRules();
  const e = embed(clip(r.title, 256), clip([r.introAr, r.introEn].filter(Boolean).join("\n\n"), 4000));
  if (r.image && /^https?:\/\//i.test(r.image)) e.setImage(r.image);
  const rows = [];
  // ديسكورد يسمح ب25 خياراً في القائمة وحدها في صفها — قانون واحد لكل صف
  if (r.sections.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("d7_rules_section")
      .setPlaceholder("إختر القسم — Pick a section")
      .setMinValues(1).setMaxValues(1)
      .addOptions(r.sections.slice(0, 25).map(s => new StringSelectMenuOptionBuilder()
        .setLabel(String(s.name || "Section").slice(0, 100))
        .setDescription(`${(s.rules || []).length} rule(s)`.slice(0, 100))
        .setValue(String(s.id).slice(0, 100))))));
  }
  return { embeds: [e], components: rows };
}

// ── شاشة القسم داخل اللوحة: معاينة + أزرار التحرير ──
function rulesSectionView(sec) {
  const card = rulesCardEmbed(sec);
  const desc = clip(`${card.data.description}\n\n---\n**Staff preview** — this is exactly what a member gets when they pick this section from the menu.`, 4000);
  return {
    embeds: [card.setDescription(desc)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`panel:rulebook:edit:${sec.id}`).setLabel("✏️ Edit rules").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`panel:rulebook:delask:${sec.id}`).setLabel("🗑️ Delete section").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel:rulebook").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
    )],
  };
}

// ── شاشة القسم داخل اللوحة الرئيسية للقوانين ──
function rulesSection(statusText) {
  const r = ensureRules();
  const where = r.messageId && safeChannelId(r.channelId)
    ? `Published in <#${r.channelId}> — it repaints itself whenever a section or this message changes.`
    : "**Not published yet** — press **📤 Publish** and pick the room.";
  const list = r.sections.length
    ? r.sections.map((s, i) => `${i + 1}. **${s.name}** — ${(s.rules || []).length} rule(s)`).join("\n")
    : "No sections yet — press **➕ Add section**.";
  const lines = [];
  if (statusText) lines.push(`**${statusText}**`, "");
  lines.push(
    `**Message:** ${where}`,
    `**Banner:** ${r.image ? "✅ image set" : "❌ no image yet"}`,
    `**Sections:** ${r.sections.length} (max 25 — one menu, one section per entry)`,
    "",
    list,
    "",
    "**How it works** — pick a section to edit it, or press **📤 Publish** to place the message in a room. Members open its menu and each choice answers with that section's rules in a private reply."
  );
  const e = embed("Control Center · Rules", lines.join("\n"));
  const rows = [];
  // قائمة الأقسام (صفّها وحده) ثم صف الخمسة أزرار ثم صف الزر واحد —
  // ثلاثة صفوف فقط، والحد الأقصى خمسة
  if (r.sections.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("d7_rulebook_sel")
      .setPlaceholder("Pick a section to view it...")
      .setMinValues(1).setMaxValues(1)
      .addOptions(r.sections.slice(0, 25).map(s => new StringSelectMenuOptionBuilder()
        .setLabel(String(s.name || "Section").slice(0, 100))
        .setDescription(`${(s.rules || []).length} rule(s)`.slice(0, 100))
        .setValue(String(s.id).slice(0, 100))))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:rulebook:add").setLabel("➕ Add section").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel:rulebook:editlist").setLabel("✏️ Edit sections").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:rulebook:dellist").setLabel("🗑️ Delete sections").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel:rulebook:settings").setLabel("✍️ Title & intro").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:rulebook:publish").setLabel("📤 Publish").setStyle(ButtonStyle.Secondary),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:home").setLabel("🏠 Home").setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [e], components: rows };
}

// ── شاشة اختيار قسم للتعديل أو للحذف: قائمة الأقسام ثم زر رجوع ──
function rulesPickView(mode) {
  const r = ensureRules();
  const editing = mode === "edit";
  if (!r.sections.length) return rulesSection("There are no sections yet — press **➕ Add section** first.");
  return {
    embeds: [embed(editing ? "✏️ Edit a section" : "🗑️ Delete a section", editing
      ? "Pick the section you want to edit — you'll get a form with its name, its Arabic rules and its English rules, **one rule per line**. The line number is the rule number in both languages."
      : "Pick the section you want to delete. You'll get a **confirmation step** first, and the published message updates the moment it is removed.")],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(editing ? "d7_rulebook_edit_sel" : "d7_rulebook_del_sel")
        .setPlaceholder(editing ? "Pick the section to edit..." : "Pick the section to delete...")
        .setMinValues(1).setMaxValues(1)
        .addOptions(r.sections.slice(0, 25).map(s => new StringSelectMenuOptionBuilder()
          .setLabel(String(s.name || "Section").slice(0, 100))
          .setDescription(`${(s.rules || []).length} rule(s)`.slice(0, 100))
          .setValue(String(s.id).slice(0, 100))))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:rulebook").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── شاشة تأكيد حذف قسم — الحذف خطوة لا رجعة فيها فلا ينفَّذ بضغطة واحدة ──
function rulesDeleteConfirm(sec) {
  return {
    embeds: [embed("⚠️ Delete this section?", [
      `**${sec.name}** — ${(sec.rules || []).length} rule(s)`,
      "",
      "It disappears from the published menu immediately, and the message repaints itself.",
      "",
      "Press **Confirm** to delete it, or **Back** to keep it.",
    ].join("\n"))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`panel:rulebook:del:${sec.id}`).setLabel("⚠️ Confirm delete").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel:rulebook").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
    )],
  };
}

// شاشة اختيار الروم لنشر رسالة القوانين
function rulesPublishView() {
  const r = ensureRules();
  const current = safeChannelId(r.channelId) ? [r.channelId] : (safeChannelId(config.channels?.rules) ? [config.channels.rules] : []);
  return {
    embeds: [embed("📤 Publish the Rules message", [
      "Pick the room — the bot posts the rules there as a **permanent message**: the intro, the banner, and the section menu.",
      "",
      "Members pick a section from the menu and get that section's rules in a private reply.",
      "",
      "Publishing in the same room **updates the message in place**; another room **moves** it (the old message is removed).",
    ].join("\n"))],
    components: [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId("d7_rules_publish_ch")
        .setPlaceholder("Pick the room for the rules message")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1).setMaxValues(1)
        .setDefaultChannels(current)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:rulebook").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// طلب أقسام داخل رسالة — عنوان ومقدمة وصورة. القيم تُملأ فقط إن وُجدت
// (رسالة فارغة لا تُرسل قيمة فارغة لنموذج مطلوب)
function rulesSettingsModal() {
  const r = ensureRules();
  const field = (b, v) => (v ? b.setValue(String(v)) : b);
  return new ModalBuilder().setCustomId("rules_settings").setTitle("Rules message")
    .addComponents(
      new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("title").setLabel("Title (Arabic | English)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256), r.title)),
      new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("ar").setLabel("Arabic intro").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000), r.introAr)),
      new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("en").setLabel("English intro").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000), r.introEn)),
      new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("image").setLabel("Banner image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300), r.image)),
    );
}

// نموذج قسم: الاسم، ثم سطور عربية سطر لكل بند، ثم سطور إنجليزية بنفس الترتيب
function rulesSectionModal(sec) {
  const arLines = (sec?.rules || []).map(l => l.ar || "").join("\n");
  const enLines = (sec?.rules || []).map(l => l.en || "").join("\n");
  const field = (b, v) => (v ? b.setValue(v) : b);
  const m = new ModalBuilder()
    .setCustomId(sec ? `rules_sec:${sec.id}` : "rules_sec:new")
    .setTitle(sec ? "Edit section" : "Add section");
  return m.addComponents(
    new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("name").setLabel("Section name (Arabic | English)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100), sec?.name)),
    new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("ar").setLabel("Arabic rules — one per line").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000), arLines)),
    new ActionRowBuilder().addComponents(field(new TextInputBuilder().setCustomId("en").setLabel("English rules — one per line").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000), enLines)),
  );
}

// سطور النموذج ← بنود: السطر رقمها هو رقم البند في اللغتين معاً
function rulesFromFields(interaction) {
  const lines = (v) => String(v || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const ar = lines(interaction.fields.getTextInputValue("ar"));
  const en = lines(interaction.fields.getTextInputValue("en"));
  const n = Math.max(ar.length, en.length);
  const rules = [];
  for (let i = 0; i < n; i++) rules.push({ ar: ar[i] || "", en: en[i] || "" });
  return { name: String(interaction.fields.getTextInputValue("name") || "").trim().slice(0, 100), rules };
}

// ── إعادة رسم الرسالة المنشورة بعد أي تغيير (قسم جديد، تعديل، حذف) ──
async function refreshRulesMessage(guild) {
  const r = ensureRules();
  if (!r.messageId || !safeChannelId(r.channelId) || !guild?.channels) return false;
  const channel = guild.channels.cache?.get(r.channelId) || await guild.channels.fetch?.(r.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) return false;
  const msg = await channel.messages.fetch(r.messageId).catch(() => null);
  if (!msg?.edit) return false;
  return !!(await msg.edit(rulesPublicPayload()).catch(() => null));
}

// ─────────── قسم المنتجات ───────────
function productsSection(message) {
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 10").all();
  const list = products.length ? products.map(p => `**#${p.id} — ${p.name}** · ${formatPrice(p.price,p.currency)} · ${p.status}`).join("\n") : "No products yet.";
  return {
    embeds: [embed("Control Center · Products", `${list}\n\nUse Add Product to create a product, or Publish Showcase to publish the product cards.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:add-product").setLabel("Add Product").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:publish-products").setLabel("Publish Showcase").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:products-list").setLabel("Refresh List").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:delete-product").setLabel("🗑️ Delete Product").setStyle(ButtonStyle.Danger)
    )],
    content: message || undefined,
  };
}

// قائمة اختيار المنتج المراد حذفه (تظهر بعد ضغط زر الحذف)
function productDeleteRows() {
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 25").all();
  if (!products.length) return null;
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId("d7_prod_del_sel").setPlaceholder("Select the product to delete permanently...").setMinValues(1).setMaxValues(1)
    .addOptions(products.map(p => new StringSelectMenuOptionBuilder()
      .setLabel(`#${p.id} — ${p.name}`.slice(0, 100))
      .setDescription(`${formatPrice(p.price, p.currency)} — permanent`.slice(0, 100))
      .setValue(String(p.id)))))];
}

// قائمة اختيار طلب — تعمل للحذف وللتعديل بنفس المظهر، ويفرّق بينهما
// معرّف القائمة فقط (حالة واحدة لكل ضغطة، كما في رسالة الحالة).
function orderPickRows(customId, placeholder) {
  const orders = db.prepare(`SELECT o.id,o.user_id,o.status,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 25`).all();
  if (!orders.length) return null;
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
    .addOptions(orders.map(o => new StringSelectMenuOptionBuilder()
      .setLabel(`#${o.id} — ${o.product_name}`.slice(0, 100))
      .setDescription(`${o.status} • buyer ${o.user_id}`.slice(0, 100))
      .setValue(String(o.id)))))];
}

// قائمة اختيار الطلب المراد حذفه (تظهر بعد ضغط زر الحذف)
function orderDeleteRows() {
  return orderPickRows("d7_order_del_sel", "Select the order to delete permanently...");
}

// ردّ على رسالة اللوحة نفسها متى أمكن (حتى لا تبقى الشاشة القديمة عالقة)
function respondWith(interaction, payload) {
  if (interaction.message && !interaction.replied && !interaction.deferred) {
    return interaction.update(payload).catch(() => interaction.reply({ ...payload, ephemeral: true }));
  }
  return interaction.reply({ ...payload, ephemeral: true });
}

// ─────────── قسم الرومات: اختيار روم الطلبات والتنبيهات ───────────
// مهم: نعرض الروم المحفوظ كقيمة مختارة (setDefaultChannels) حتى لا يظهر القائمة فاضية
// بعد الرجوع للقسم — وهذا سبب "ما تنحفظ" اللي كان يظهر للمستخدم.
function channelRow(id, key, placeholder) {
  const sel = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1);
  const current = config.channels?.[key];
  if (safeChannelId(current)) sel.setDefaultChannels([current]);
  return sel;
}

function chLabel(key) {
  const id = config.channels?.[key];
  return safeChannelId(id) ? `<#${id}>` : "Not set";
}

function channelsSection() {
  const rows = [
    new ActionRowBuilder().addComponents(channelRow("d7_ch_orders", "orders", `🔔 Order log channel — current: ${chLabel("orders")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ch_sales", "salesLogs", `🛒 Purchase request channel — current: ${chLabel("salesLogs")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ch_showcase", "productShowcase", `🛍️ Showcase channel — current: ${chLabel("productShowcase")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_welcome_ch", "welcome", `👋 Welcome channel — current: ${chLabel("welcome")}`)),
    // ⚠️ روم التقييمات ما عاد هنا — صار في قسم التقييمات فقط حتى ما يتكرر
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Back to menu").setStyle(ButtonStyle.Secondary)),
  ];
  return { embeds: [embed("📌 Channels", "Pick the right channel in each menu — saved instantly.\nThe ratings channel is set from **⭐ Ratings**.")], components: rows };
}

// ─────────── قسم الترحيب ───────────
// رسالة الترحيب تُرسل للعضو على **الخاص** كنص عادي بلا إيمبد (طلب الصاحب).
// ما يُنشر في روم الترحيب إلا في وضع "روم الترحيب" الصريح: وظيفة "الاحتياطي"
// السابقة كانت تنشر إيمبد الروم عند كل انضمام لاعب خاصه مقفول — ضجيج طلبه
// الصاحب أن يزول، فصار الخاص وحده في وضع الخاص.
function ensureWelcome() {
  const w = (config.welcome ||= {});
  if (w.enabled === undefined) w.enabled = true;
  if (w.sendDM === undefined) w.sendDM = true;
  w.title ??= "Welcome to S2A DEV!";
  w.message ??= "S2A DEV is a professional development studio specializing in high-quality FiveM scripts, modern UI designs, and innovative solutions built to enhance your server experience.";
  w.footer ??= "All Rights Reserved [S2A DEV]";
  w.storeRoleId ??= "";
  w.storeChannelId ??= "";
  w.helpChannelId ??= "";
  w.releasesChannelId ??= "";
  w.imageUrl ??= "";
  return w;
}

// صفوف روابط الترحيب — كل سطر يظهر فقط إذا حددت له رتبة أو روم
function welcomeLines() {
  const w = ensureWelcome();
  const lines = [];
  const store = [];
  if (safeChannelId(w.storeRoleId)) store.push(`<@&${w.storeRoleId}>`);
  if (safeChannelId(w.storeChannelId)) store.push(`<#${w.storeChannelId}>`);
  if (store.length) lines.push(`▸ **Explore Our Store:** ${store.join("  ")}`);
  if (safeChannelId(w.helpChannelId)) lines.push(`▸ **Need Help?:** <#${w.helpChannelId}>`);
  if (safeChannelId(w.releasesChannelId)) lines.push(`▸ **Latest Releases:** <#${w.releasesChannelId}>`);
  return lines;
}

// حمولة رسالة الترحيب — نفس الشي اللي يشوفه العضو في الخاص والمعاينة في اللوحة
function welcomePayload() {
  const w = ensureWelcome();
  const lines = welcomeLines();
  const body = [w.message || "", lines.length ? "" : null, ...lines]
    .filter(x => x !== null && x !== "")
    .join("\n");
  const e = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(EMBED_THUMB)
    .setTitle(w.title || "Welcome!")
    .setDescription(body || " ")
    .setFooter({ text: w.footer || config.brand?.footer || "S2A DEV" });
  if (safeChannelId(w.imageUrl) || /^https?:\/\//.test(w.imageUrl || "")) e.setImage(w.imageUrl);
  return { embeds: [e] };
}

// رسالة الترحيب للخاص — نص عادي لا إيمbedo (طلب الصاحب الصريح: "خليها رسالة عادية").
// عنوان بارز + النص + سطور الروابط + التذييل، بحدّ ديسكورد 2000 حرف للنص.
function welcomeDMText() {
  const w = ensureWelcome();
  const title = String(w.title || "Welcome!").replace(/\*/g, "");
  const body = [w.message || "", ...welcomeLines()].filter(x => x !== "" && x != null).join("\n");
  const parts = [`**${title}**`];
  if (body) parts.push(body);
  if (w.footer) parts.push(`*${w.footer}*`);
  return parts.join("\n\n").slice(0, 2000);
}

// حمولة رسالة الترحيب للخاص: النص العادي نفسه + الصورة كإيمبد صافٍ فقط
// (بلا عنوان ولا نص) — الرابط يظهر كصورة نظيفة بدل سطر مكشوف فوقها.
function welcomeDMPayload() {
  const w = ensureWelcome();
  const payload = { content: welcomeDMText() };
  if (/^https?:\/\//.test(w.imageUrl || "")) {
    payload.embeds = [new EmbedBuilder().setColor(EMBED_COLOR).setImage(w.imageUrl)];
  }
  return payload;
}

// ─────────── رسالة الترحيب المثبّتة (D7 Dev) ───────────
// بذرتها الأصلية نص ثابت طلبه صاحب المتجر، والآن صارت قابلة للتعديل من
// داخل اللوحة (زر ✏️ Edit intro في شاشة Send & Test): العنوان والنص والصورة —
// وكل تعديل يعيد رسم الرسالة المنشورة إن كانت قد نُشرت من قبل.
// ما يزال منفصلًا عن نص الترحيب التلقائي (رسالة الخاص لحظة الانضمام).
const WELCOME_INTRO = {
  title: "✦ Welcome to D7 Dev",
  lines: [
    "Welcome to **D7 Dev** — where creativity meets precision.",
    "Explore premium FiveM resources, OneSync solutions, and custom-developed scripts built to elevate your server experience.",
    "**Innovate. Develop. Stand Out.**",
    "We're glad to have you here. 💠",
  ],
};

// الحالة القابلة للتعديل في config.welcomeIntro — البذرة من WELCOME_INTRO
// مرة واحدة فقط: مصفوفة محذوفة عن قصد لا تمتلئ من جديد (نفس منطق القوانين)
function ensureIntro() {
  const i = (config.welcomeIntro ||= {});
  i.title ??= WELCOME_INTRO.title;
  i.text ??= WELCOME_INTRO.lines.join("\n\n");
  i.image ??= "";
  i.channelId ??= "";
  i.messageId ??= "";
  return i;
}

// حمولة رسالة الترحيب المثبّتة — نفس ما يُعرض في اللوحة وما يُنشر في الروم
function welcomeIntroPayload() {
  const i = ensureIntro();
  const e = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(EMBED_THUMB)
    .setTitle(String(i.title || WELCOME_INTRO.title).slice(0, 256))
    .setDescription(String(i.text || WELCOME_INTRO.lines.join("\n\n")).slice(0, 4096) || " ");
  if (/^https?:\/\//.test(i.image || "")) e.setImage(i.image);
  return { embeds: [e] };
}

// إعادة رسم الرسالة المثبّتة بعد تعديل النص أو الصورة — بعد الاعتراف بالضغط
async function refreshIntroMessage(guild) {
  const i = ensureIntro();
  if (!i.messageId || !safeChannelId(i.channelId) || !guild?.channels) return false;
  const channel = guild.channels.cache?.get(i.channelId) || await guild.channels.fetch?.(i.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) return false;
  const msg = await channel.messages.fetch(i.messageId).catch(() => null);
  if (!msg?.edit) return false;
  return !!(await msg.edit(welcomeIntroPayload()).catch(() => null));
}

function welcomeChannelRow(id, currentId, placeholder) {
  const sel = new ChannelSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    // min 0 حتى تقدر تمسح الرابط وتختفي من الرسالة
    .setMinValues(0)
    .setMaxValues(1);
  if (safeChannelId(currentId)) sel.setDefaultChannels([currentId]);
  return sel;
}

function welcomeSection(statusText) {
  const w = ensureWelcome();

  const roleSel = new RoleSelectMenuBuilder()
    .setCustomId("d7_welcome_role")
    .setPlaceholder(w.storeRoleId ? `🛍️ Store role — current: <@&${w.storeRoleId}>` : "🛍️ Explore Our Store role — not set")
    .setMinValues(0)
    .setMaxValues(1);
  if (safeChannelId(w.storeRoleId)) roleSel.setDefaultRoles([w.storeRoleId]);

  const rows = [
    new ActionRowBuilder().addComponents(roleSel),
    // ⬇️ القنوات الثلاث — كل قائمة في صفها وحدها. هذا قانون ديسكورد
    // الصريح: عرض القائمة = 5 من 5 وصفها لا يخلط معها شيئاً. دمجها في صف
    // واحد رُفض بـ400 COMPONENT_LAYOUT_WIDTH_EXCEEDED وأسقط البوت كاملاً
    // قبل أن يصل ردّه فظهرت للمستخدم "didn't respond in time". القيمة
    // المحفوظة تظهر اسم الروم مكان التسمية فلا تُختصر التسمية أصلاً.
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_store", w.storeChannelId, `🏪 Store channel — ${w.storeChannelId ? `<#${w.storeChannelId}>` : "Not set"}`)),
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_help", w.helpChannelId, `🆘 Help channel (Need Help) — ${w.helpChannelId ? `<#${w.helpChannelId}>` : "Not set"}`)),
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_releases", w.releasesChannelId, `🚀 Latest Releases channel — ${w.releasesChannelId ? `<#${w.releasesChannelId}>` : "Not set"}`)),
    // ⬇️ صف الأزرار الوحيد الممكن: الرتبة + ثلاث قوائم + الأزرار = خمسة صفوف
    // بالضبط (حدّ ديسكورد)، وخمسة أزرار كحدّ أقصى في الصف. لذلك اجتمع
    // زرا الإرسال والتجربة خلف زر واحد «Send & Test»: تفتح شاشة فيها نشر
    // الرسالة المثبّتة (D7 Dev) في الروم + اختيار عضو لتجربة ما يصله،
    // ولا يُضحى بأيّ من الميزتين — زر الإرسال القديم صار داخل تلك الشاشة.
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:welcome:toggle").setLabel(w.enabled === false ? "❌ Welcome: off" : "✅ Welcome: on").setStyle(w.enabled === false ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:welcome:mode").setLabel(w.sendDM === false ? "🗨️ Send: welcome channel" : "📨 Send: member DM").setStyle(w.sendDM === false ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:welcome:text").setLabel("✏️ Text & image").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:welcome:test").setLabel("📨 Send & Test").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  // المعاينة = ما ينشره زر الإرسال، ثم رسالة الترحيب التلقائية بالضبط
  const preview = welcomePayload();
  const meta = [
    `**Welcome channel:** ${chLabel("welcome")} — used in room-send mode and by 📨 Post intro in the room (Send & Test screen).`,
    "📨 **Post intro in the room** (inside **Send & Test**) posts the **first** embed below in that channel.",
    "The second embed previews the joining message: in DM mode the member receives it as a **plain text DM** and nothing is posted in the room; in room mode it is posted there as this embed.",
  ];
  return { content: [statusText, ...meta].filter(Boolean).join("\n"), embeds: [...welcomeIntroPayload().embeds, ...preview.embeds], components: rows };
}

// شاشة زر التجربة: اختيار عضو عبر قائمة المستخدمين (UserSelect) ثم رجوع
// لقسم الترحيب بنتيجة الإرسال — رديت على زر واحد لا يبقى على الشاشة
function welcomeTestView() {
  const dmMode = config.welcome?.sendDM !== false;
  return {
    content: [
      "🧪 **Send & Test**",
      "Pick a member below — they receive exactly what a joining member would get right now:",
      `• **Current mode:** ${dmMode ? "member DM (plain text)" : "welcome channel (embed with a ping)"}`,
      "• The on/off toggle does not affect this test.",
      "",
      "**📨 Post intro in the room** publishes the pinned welcome below (the D7 Dev copy) in the welcome channel — staff action, no member involved.",
      "**✏️ Edit intro** edits that same pinned message: its title, its text and an optional image. If it was already posted, the posted message repaints itself.",
      "After sending you return here with the result.",
    ].join("\n"),
    components: [
      new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
        .setCustomId("d7_welcome_test_sel")
        .setPlaceholder("Pick the member to send the test welcome to…")
        .setMinValues(1)
        .setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        // زر النشر اليدوي نزل إلى هنا من اللوحة الرئيسية: صفوف القسم بلغت
        // خمسة (حدّ ديسكورد) فلا يتّسع لزر سادس هناك، وهذه الشاشة ضِيق
        // فتسع. زر التعديل إلى جانبه: نفس الرسالة المثبّتة — نصها وصورتها.
        new ButtonBuilder().setCustomId("panel:welcome:intro-edit").setLabel("✏️ Edit intro").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:welcome:send").setLabel("📨 Post intro in the room").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("panel:welcome").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ─────────── قسم التذاكر (مطابق لصورة لوحة تحكم NSR) ───────────
function ticketsSection() {
  const t = tickets.ensureConfig();
  const all = tickets.types();
  const on = all.filter(x => x.enabled !== false);
  const lines = all.length
    ? all.map(tp => `${tp.enabled === false ? "❌" : "✅"} ${tp.emoji || ""} **${tp.label}** — ${tp.description}${String(tp.id || "").startsWith("c") ? " *(custom)*" : ""}`).join("\n")
    : "No types yet. Press **➕ Add Type** below.";

  const e = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(EMBED_THUMB)
    .setTitle("🎫 Ticket System")
    .setDescription([
      `**Panel title:** ${t.panel?.title || "🎫 Support Tickets"}`,
      `**Status:** ${on.length} of ${all.length || 0} types enabled`,
      "",
      "**Types:**",
      lines,
      "",
      `**Category:** ${safeChannelId(t.categoryId) ? `<#${t.categoryId}>` : "Not set"}`,
      `**Log channel:** ${safeChannelId(t.logChannelId) ? `<#${t.logChannelId}>` : "Not set"}`,
      `**Support roles:** ${(t.staffRoles || []).length ? t.staffRoles.map(r => `<@&${r}>`).join(" ") : "None"}`,
    ].join("\n"))
    .setFooter({ text: config.brand?.footer || "S2A DEV" })
    .setTimestamp();

  const rows = [];
  // 5 أزرار كحد أقصى في كل صف — نقسّم الأنواع على صفوف
  for (let i = 0; i < all.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(all.slice(i, i + 5).map(tp => {
      const btn = new ButtonBuilder()
        .setCustomId(`d7_tk_btn:${tp.id}`)
        .setLabel(tp.label)
        .setStyle(tp.enabled === false ? ButtonStyle.Secondary : ButtonStyle.Success);
      if (tp.emoji && /^\p{Extended_Pictographic}$/u.test(tp.emoji.trim())) btn.setEmoji(tp.emoji.trim());
      return btn;
    })));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("d7_tk_add").setLabel("➕ Add Type").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("d7_tk_del").setLabel("🗑️ Delete Type").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel:publish-tickets").setLabel("⬆️ Send Ticket Panel").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("d7_tk_text").setLabel("✏️ Panel Text").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Back to Home").setStyle(ButtonStyle.Secondary),
  ));

  const category = new ChannelSelectMenuBuilder().setCustomId("d7_tk_category")
    .setPlaceholder(`📁 Category — current: ${safeChannelId(t.categoryId) ? `<#${t.categoryId}>` : "Not set"}`)
    .addChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
  if (safeChannelId(t.categoryId)) category.setDefaultChannels([t.categoryId]);
  const log = new ChannelSelectMenuBuilder().setCustomId("d7_tk_log")
    .setPlaceholder(`📋 Log channel — current: ${safeChannelId(t.logChannelId) ? `<#${t.logChannelId}>` : "Not set"}`)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1);
  if (safeChannelId(t.logChannelId)) log.setDefaultChannels([t.logChannelId]);
  const staff = new RoleSelectMenuBuilder().setCustomId("d7_tk_staff")
    .setPlaceholder(`👮 Support roles — current: ${(t.staffRoles || []).length} selected`)
    .setMinValues(0).setMaxValues(10);
  if ((t.staffRoles || []).length) staff.setDefaultRoles(t.staffRoles);

  rows.push(new ActionRowBuilder().addComponents(category));
  rows.push(new ActionRowBuilder().addComponents(log));
  rows.push(new ActionRowBuilder().addComponents(staff));

  return { embeds: [e], components: rows.slice(0, 5) };
}

// وضع حذف نوع التذكرة (الأنواع المخصصة فقط)
function ticketDeleteRows() {
  const custom = tickets.types().filter(x => String(x.id || "").startsWith("c"));
  const rows = [];
  if (custom.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("d7_tk_del_sel")
      .setPlaceholder("Select the custom type to delete...")
      .addOptions(custom.map(tp => {
        const opt = new StringSelectMenuOptionBuilder().setLabel(tp.label).setDescription(tp.description).setValue(tp.id);
        if (tp.emoji && /^\p{Extended_Pictographic}$/u.test(tp.emoji.trim())) opt.setEmoji(tp.emoji.trim());
        return opt;
      }))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("d7_tk_del_back").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// ─────────── قسم الطلبات: إحصاءات + حذف + تعديل + اختيار الرومات ───────────
// opts.published = هذه الشاشة معروضة كرسالة ثابتة في روم لا كلوحة خاصة:
// يسقط منها زر Home (لأنه سيحوّل رسالة الروم إلى اللوحة الرئيسية) ويُستبدل
// بزر النشر/التحديث، وتُضاف علامة توضّح أنها تتحدث من نفسها.
function ordersSection(statusText, opts = {}) {
  const published = !!opts.published;
  // عدّاد لكل حالة — طلب الصاحب: كم طلب موجود، وكم مكتمل/ملغي/قيد التنفيذ/بانتظار التأكيد
  const counts = { pending: 0, confirmed: 0, delivered: 0, cancelled: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM orders GROUP BY status").all()) {
    if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status] = Number(r.n);
  }
  const total = counts.pending + counts.confirmed + counts.delivered + counts.cancelled;
  // ── إحصائيات الشراء: قيمة ما تم تنفيذه فعلاً (دخل المتجر)، وما هو
  // بانتظار تأكيد الدفع، وعدد المشترين — طلب صاحب اللوحة صراحةً:
  // "فيه احصائيات الشراء والطلبات وكل شي". السعر والعملة في جدول
  // المنتجات لا في جدول الطلبات، فنjoinهما، وكل عملة تُجمع وحدها حتى لا
  // تُجمع الريال بالدولار في رقم واحد كاذب.
  const sumBy = (statuses) => {
    const q = `SELECT p.currency currency, SUM(p.price) v FROM orders o JOIN products p ON p.id=o.product_id
               WHERE o.status IN (${statuses.map(() => "?").join(",")}) GROUP BY p.currency`;
    return db.prepare(q).all(...statuses).map(r => formatPrice(r.v, r.currency));
  };
  const revenue = sumBy(["delivered"]);
  const waitingValue = sumBy(["pending"]);
  const buyers = Number(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM orders").get().n);
  const completedValue = revenue.length ? revenue.join(" + ") : formatPrice(0);
  const waitingText = waitingValue.length ? waitingValue.join(" + ") : formatPrice(0);
  const stats = [
    `**Total orders:** ${total}`,
    `⏳ **Pending confirmation:** ${counts.pending} · 🚀 **In progress:** ${counts.confirmed}`,
    `✅ **Completed:** ${counts.delivered} · ❌ **Cancelled:** ${counts.cancelled}`,
    "",
    `💰 **Sales value (completed):** ${completedValue}`,
    `🧾 **Awaiting confirmation:** ${waitingText} · 👥 **Buyers:** ${buyers}`,
  ].join("\n");
  const rowsData = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
  // كل طلب سطراه بعده بسطر فارغ — قائمة تُقرأ طلباً طلباً لا ككتلة واحدة،
  // وإيموجي الحالة أسرع للعين من الكلمة وحدها
  const desc = rowsData.length
    ? rowsData.map(o => `**#${o.id}** · ${o.product_name} · <@${o.user_id}> · ${(ORDER_STATUS[o.status]?.emoji || "")} **${o.status}** · ${formatPrice(o.price,o.currency)}\n⭐ ${o.rating ? `${o.rating}/5` : "no rating"}`).join("\n\n")
    : "No orders yet.";
  const pending = db.prepare(`SELECT o.id,o.user_id,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.status='pending' ORDER BY o.id DESC LIMIT 20`).all();
  const rows = [];
  if (pending.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("d7_order_confirm").setPlaceholder("✅ Pick an order to confirm payment and grant the role").setMinValues(1).setMaxValues(1)
      .addOptions(pending.map(o => new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} — ${o.product_name}`.slice(0, 100))
        .setDescription(`${o.user_id} • ${formatPrice(o.price,o.currency)}`.slice(0, 100))
        .setValue(String(o.id))))));
  }
  // ⬇️ قوائم الرومات الثلاث — كل قائمة في صفها وحدها: هذا قانون ديسكورد
  // الصريح (عرض القائمة = 5 من 5، وصف القائمة لا يخلط شيئاً معها)، ودمجها
  // في صف واحد رُفض بـ400 COMPONENT_LAYOUT_WIDTH_EXCEEDED وأسقط البوت كاملاً
  // فظهر لصاحب اللوحة "didn't respond in time". وفي اللوحة المنشورة لا
  // تُعرض إطلاقاً — طلبها صاحب اللوحة: لوحة طلبات لا إعدادات.
  if (!published) {
    // الـ placeholder يظهر فقط لما ما يكون فيه روم محفوظ — ولو كان محفوظاً
    // يظهر اسمه داخل القائمة مكانها، عشان كذا نذكر كل روم في نص الرسالة.
    rows.push(new ActionRowBuilder().addComponents(channelRow("d7_order_ch", "orders", "🛒 Pick the purchase log channel")));
    rows.push(new ActionRowBuilder().addComponents(channelRow("d7_order_status_ch", "orderStatus", "🚚 Pick the order status channel")));
    rows.push(new ActionRowBuilder().addComponents(channelRow("d7_prod_status_ch", "productStatus", "🔄 Pick the product status channel")));
  }
  // ⬇️ صف الأزرار. اللوحة المنشورة = ثلاثة أزرار فقط كما طلبها صاحب
  // اللوحة حرفياً: عرض المعلومات، حذف الطلب، تعديل الطلب. لا زر نشر ولا
  // تحديث هناك — النشر يتم من /panel، والتحديث يحدث تلقائياً مع كل تغيير
  // في الطلبات. وفي /panel يبقى الخمسة كاملة: الثلاثة + النشر + Home
  // (الصفوف بلغت خمسة: معلّق + ثلاث قوائم + الأزرار، فلا يتّسع صف سادس).
  const buttons = [
    new ButtonBuilder().setCustomId("panel:orders:view").setLabel("👁️ View Details").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:orders:del").setLabel("🗑️ Delete Order").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel:orders:edit").setLabel("✏️ Edit Order").setStyle(ButtonStyle.Primary),
  ];
  if (!published) {
    buttons.push(new ButtonBuilder().setCustomId("panel:orders:publish").setLabel("📤 Publish panel").setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary));
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return {
    content: statusText || undefined,
    embeds: [embed("🧾 Orders", [
      stats,
      "",
      "**Recent orders:**",
      desc,
      ...(published ? [
        // لوحة الطلبات المنشورة: لا قوائم إعدادات ولا شرح طويل —
        // طلبات وإحصائيات فقط، وأزرارها ثلاثة كما طلب صاحب اللوحة.
        "",
        "📌 **Live panel** — refreshes itself every time an order is created, confirmed, changed or deleted.",
        "**👁️ View Details** — pick an order and get its full card: buyer, admin, product, price, times, rating and review.",
        "**🗑️ Delete Order** · **✏️ Edit Order** — manage an order straight from this message.",
      ] : [
        "",
        "Confirm payment from the menu above; the customer is granted the product role automatically.",
        `**🛒 Purchase log: ${chLabel("orders")}** — set by the menu below. Every purchase posts a message with the role, buyer and price.`,
        `**🚚 Order status: ${chLabel("orderStatus")}** — set by the menu below. Every confirmation, delivery or cancellation updates one status message per order.`,
        `**🔄 Product status: ${chLabel("productStatus")}** — set by the menu below. Every product status change posts a message.`,
        "",
        "📤 **Publish panel** puts this list in a channel as a permanent message everyone can see.",
      ]),
    ].join("\n"))],
    // خمسة صفوف كحد أقصى (حد ديسكورد): معلّق + الرومات + الأزرار + Home = 4
    components: rows.slice(0, 5),
  };
}

// ─────────── اللوحة المنشورة: رسالة ثابتة للطلبات في روم ───────────
// config.ordersPanel = { channelId, messageId } تُحفظ في config.json وتتزامن
// مع المستودع عبر سكربت المزامنة، فتعيش اللوحة بعد إعادة تشغيل البوت.
function isPublishedPanel(interaction) {
  return !!(config.ordersPanel?.messageId && interaction.message?.id === config.ordersPanel.messageId);
}

// ردّ شاشة الطلبات: نسخة منشورة إذا كانت هذه الرسالة هي اللوحة المنشورة،
// وإلا النسخة العادية (لوحة `/panel` الخاصة أو أي ردّ آخر).
function ordersPanelPayload(interaction, statusText) {
  return ordersSection(statusText, { published: isPublishedPanel(interaction) });
}

// إعادة رسم اللوحة المنشورة بعد أي تغيير في الطلبات. تُستدعى قبل الردّ
// على الضاغط حتى يكون ردّ الضاغط هو الكتابة الأخيرة (فلا تُمحى نصوص النجاح).
// لو لم تُنشر اللوحة بعد فلا تفعل شيئاً.
async function refreshOrdersPanel(guild) {
  const op = config.ordersPanel;
  if (!op?.messageId || !guild?.channels) return false;
  // الكاش يمتلئ بعد الإقلاع، والجلب احتياطي لو غاب الروم من الكاش
  const channel = guild.channels.cache?.get(op.channelId) || await guild.channels.fetch?.(op.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages?.fetch) return false;
  const msg = await channel.messages.fetch(op.messageId).catch(() => null);
  if (!msg?.edit) return false;
  return !!(await msg.edit(ordersSection(undefined, { published: true })).catch(() => null));
}

// شاشة اختيار الروم لنشر اللوحة (تظهر بعد ضغط زر النشر)
function ordersPublishView() {
  return {
    embeds: [embed("📤 Publish the Orders list", [
      "Pick the channel — the bot posts the board there as a **permanent message**: purchase statistics, every order, and three buttons (👁️ View Details · 🗑️ Delete Order · ✏️ Edit Order).",
      "",
      "It refreshes itself every time an order changes, and staff can view, delete or edit orders straight from it.",
      "",
      "Publishing in another channel **moves** the board (the old message is removed).",
    ].join("\n"))],
    components: [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId("d7_order_publish_ch")
        .setPlaceholder("Pick the channel for the orders panel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// شاشة تعديل طلب واحد: أزرار الحالة الأربعة نفسها الموجودة في رسالة
// الحالة، لكن بمعرّف خاص (d7_panel_status) لا يمسّ مؤشر رسالة الحالة.
function orderEditStatusView(order) {
  return {
    embeds: [embed(`✏️ Edit order #${order.id}`, [
      `**${order.product_name || order.name || "Product"}** · <@${order.user_id}> · **${order.status}**`,
      order.price != null ? `Price: ${formatPrice(order.price, order.currency)}` : "",
      "",
      "Pick the new status — the order's status message and this list update together.",
      order.status === "confirmed" ? "✅ *Confirming again here grants the product role, same as the status message.*" : "",
    ].filter(Boolean).join("\n"))],
    components: [
      new ActionRowBuilder().addComponents(ORDER_STATUS_ACTIONS.map(a =>
        new ButtonBuilder()
          .setCustomId(`d7_panel_status:${order.id}:${a.key}`)
          .setLabel(a.label)
          .setStyle(a.style)
          .setDisabled(order.status === a.key))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ─────────── بطاقة الطلب الكاملة: كل ما يخص الطلب في إيمبد واحد ───────────
// زر 👁️ View Details → اختيار الطلب → هذي البطاقة. مطلوب الصاحب صراحةً:
// مين طلب، مين الأدامي، وكل ما يخص الطلب — بلا فتح أي رسالة أخرى.
function orderDetailsView(order) {
  const st = ORDER_STATUS[order.status] || { label: order.status || "Unknown", emoji: "ℹ️" };
  // الوقت بصيغة ديسكورد <t:…:F> فيعرضه كل واحد بتوقيته المحلي وبلغته
  const at = (v) => {
    if (!v) return null;
    const t = Date.parse(String(v).trim().replace(" ", "T").replace(/Z?$/, "Z"));
    return Number.isNaN(t) ? String(v) : `<t:${Math.floor(t / 1000)}:F>`;
  };
  const lines = [
    `**Product:** ${order.name || "—"} (ID ${order.product_id})`,
    order.role_id ? `**Role:** <@&${order.role_id}>` : "",
    `**Buyer:** <@${order.user_id}> — \`${order.user_id}\``,
    `**Admin:** ${order.confirmed_by ? `<@${order.confirmed_by}> — \`${order.confirmed_by}\`` : "— not confirmed yet"}`,
    `**Price:** ${formatPrice(order.price, order.currency)}`,
    "",
    `**Status:** ${st.emoji} ${st.label}`,
    `**Ordered:** ${at(order.created_at) || "—"}`,
    `**Confirmed:** ${at(order.confirmed_at) || "— not yet"}`,
    `**Delivered:** ${at(order.delivered_at) || "— not yet"}`,
    order.delivery_seconds !== null && order.delivery_seconds !== undefined && order.delivery_seconds !== ""
      ? `**Delivery time:** ${Math.floor(Number(order.delivery_seconds) / 60)}m ${Number(order.delivery_seconds) % 60}s`
      : "",
    "",
    `**Rating:** ${order.rating ? `⭐ ${order.rating}/5` : "Not rated yet"}`,
    order.review ? `**Review:** ${order.review}` : "",
  ].filter(Boolean);
  return {
    embeds: [embed(`📋 Order #${order.id} · ${st.emoji} ${st.label}`, lines.join("\n"))],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:orders:view").setLabel("👁️ Another order").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ─────────── قسم التقييمات (نسخة من NSR Hub) ───────────
function ratingsSection() {
  const products = db.prepare("SELECT id,name,price,currency FROM products ORDER BY id DESC").all();
  const list = products.length
    ? products.map(p => {
        const r = db.ratings.byProduct(p.id);
        return `**#${p.id} — ${p.name}** — ${r.n ? `${Number(r.avg).toFixed(1)}/5 (${r.n} ratings)` : "Not rated"}`;
      }).join("\n")
    : "No products yet.";
  const rows = [
    new ActionRowBuilder().addComponents(channelRow("d7_pcheck_ch", "purchaseChecks", `🛒 Purchase check channel — current: ${chLabel("purchaseChecks")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ratings_ch", "reviews", `⭐ Ratings channel — current: ${chLabel("reviews")}`)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_rate_send").setLabel("⭐ Send Rating to Customer").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:ratings").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("⭐ Ratings System", [
    `${list}`,
    "",
    `**Purchase check channel:** ${safeChannelId(config.channels?.purchaseChecks) ? `<#${config.channels.purchaseChecks}>` : "Not set — the rating DM is sent with no confirmation step."}`,
    "Any member who receives a product role gets a check in that channel: confirming sends the rating DM, rejecting sends nothing.",
    "",
    `**Ratings channel:** ${chLabel("reviews")} — ratings are posted here.`,
  ].join("\n"))], components: rows };
}

// ─────────── قسم إعدادات المتجر ───────────
function storeSection() {
  const p = config.purchase ||= {};
  const btn = (id, label, on) => new ButtonBuilder().setCustomId(id).setLabel(`${on ? "✅" : "❌"} ${label}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  const rows = [
    new ActionRowBuilder().addComponents(
      btn("panel:store:manual", "Manual payment confirmation", p.manualConfirmation !== false),
      btn("panel:store:thankyou", "Thank-you DM", p.sendThankYouDM === true),
      btn("panel:store:reviewdm", "Rating DM", p.sendProductReviewDM === true),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🛒 Store Settings", [
    `**Manual payment confirmation:** ${p.manualConfirmation !== false ? "✅ On" : "❌ Off"} — orders need staff approval before the role is granted.`,
    `**Thank-you message:** ${p.sendThankYouDM === true ? "✅ On" : "❌ Off"} — a DM sent once the order is confirmed.`,
    `**Rating message:** ${p.sendProductReviewDM === true ? "✅ On" : "❌ Off"} — sent automatically to whoever takes any product role.`,
    "",
    "Press a button to toggle it.",
  ].join("\n"))], components: rows };
}

// ─────────── قسم الصلاحيات ───────────
function permsSection() {
  const admins = (config.permissions?.adminUserIds || []).filter(Boolean);
  const staffRoles = (config.roles?.staff || []).filter(Boolean);
  const adminRole = config.roles?.admin || [];
  const roleSelect = new RoleSelectMenuBuilder().setCustomId("d7_perm_staff")
    .setPlaceholder(`👮 Admin/staff roles — current: ${staffRoles.length} selected`)
    .setMinValues(0).setMaxValues(10);
  if (staffRoles.length) roleSelect.setDefaultRoles(staffRoles);
  const rows = [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_perm_admins").setLabel("🔑 Bot Managers").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🔐 Permissions", [
    `**Bot managers:** ${admins.length ? admins.map(id => `<@${id}>`).join(" ") : "None"}`,
    `**Admin roles:** ${adminRole.length ? adminRole.map(id => `<@&${id}>`).join(" ") : "None"}`,
    `**Staff roles:** ${staffRoles.length ? staffRoles.map(id => `<@&${id}>`).join(" ") : "None"}`,
    "",
    "Who is allowed to use the panel commands.",
  ].join("\n"))], components: rows };
}

// ─────────── إحصائيات التذاكر ───────────
function ticketStatsSection() {
  const s = db.tickets.stats(null);
  const rows = db.prepare(`SELECT type, COUNT(*) c FROM tickets GROUP BY type ORDER BY c DESC`).all();
  const byType = rows.length ? rows.map(r => `**${r.type}** — ${r.c}`).join("\n") : "No tickets yet.";
  const open = db.prepare(`SELECT number,user_id,type,created_at FROM tickets WHERE status='open' ORDER BY created_at DESC LIMIT 10`).all();
  const openList = open.length ? open.map(t => `**#${t.number}** · ${t.type} · <@${t.user_id}>`).join("\n") : "No open tickets.";
  return {
    embeds: [embed("📈 Ticket Statistics", [
      `**Total:** ${s.total} · **Open:** ${s.open} · **Closed:** ${s.closed} · **Today:** ${s.today}`,
      "",
      "**By type:**",
      byType,
      "",
      "**Currently open:**",
      openList,
    ].join("\n"))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:ticket-stats").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    )],
  };
}

// ─────────── قسم الرتب التلقائية ───────────
// نفس مبدأ قسم الرومات: نعرض الرتبة المحفوظة كقيمة مختارة، ونعيد رسم القسم بعد الحفظ.
function autorolesSection(statusText) {
  config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
  const a = config.autoRoles;
  const memberSel = new RoleSelectMenuBuilder().setCustomId("autorole_select:member")
    .setPlaceholder(a.memberRoleId ? `👤 Member role — current: <@&${a.memberRoleId}>` : "👤 Member role — not set")
    .setMinValues(0).setMaxValues(1);
  if (a.memberRoleId) memberSel.setDefaultRoles([a.memberRoleId]);
  const botSel = new RoleSelectMenuBuilder().setCustomId("autorole_select:bot")
    .setPlaceholder(a.botRoleId ? `🤖 Bot role — current: <@&${a.botRoleId}>` : "🤖 Bot role — not set")
    .setMinValues(0).setMaxValues(1);
  if (a.botRoleId) botSel.setDefaultRoles([a.botRoleId]);
  const rows = [
    new ActionRowBuilder().addComponents(memberSel),
    new ActionRowBuilder().addComponents(botSel),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:autoroles-toggle").setLabel(`${a.enabled ? "✅" : "❌"} ${a.enabled ? "Disable Auto Roles" : "Enable Auto Roles"}`).setStyle(a.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🏷️ Auto Roles", [
    `**Status:** ${a.enabled ? "✅ On" : "❌ Off"}`,
    `**Member role:** ${a.memberRoleId ? `<@&${a.memberRoleId}>` : "Not set"}`,
    `**Bot role:** ${a.botRoleId ? `<@&${a.botRoleId}>` : "Not set"}`,
    "",
    "Pick roles from the menus below — saved instantly.",
    "The bot needs **Manage Roles**, and its own role must sit above the ones it assigns.",
  ].join("\n") + (statusText ? `\n\n${statusText}` : ""))], components: rows };
}

function productEmbed(product) {
  const e = embed(product.name, product.description || "No description provided.");
  e.addFields(
    { name: "Price", value: formatPrice(product.price, product.currency), inline: true },
    { name: "Status", value: product.status === "maintenance" ? "Under maintenance" : product.status === "stopped" ? "Unavailable" : "Working normally", inline: true },
    { name: "Purchases", value: String(db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id=? AND status IN ('confirmed','delivered')").get(product.id).n), inline: true }
  );
  if (product.image_url) e.setImage(product.image_url);
  return e;
}

function productPanelRows(productId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`buy_request:${productId}`).setLabel("Request purchase").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`product_info:${productId}`).setLabel("Product details").setStyle(ButtonStyle.Secondary)
  )];
}

async function refreshAdminDashboard(guild) {
  const channel = channelFromConfig(guild, "adminDashboard");
  if (!channel?.isTextBased()) return;
  const totalOrders = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','delivered')").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='pending'").get().n;
  const revenue = db.prepare(`SELECT COALESCE(SUM(p.price),0) total FROM orders o JOIN products p ON p.id=o.product_id WHERE o.status IN ('confirmed','delivered')`).get().total;
  const openTickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='open'").get().n;
  const top = db.prepare(`SELECT p.name, COUNT(o.id) n FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.status IN ('confirmed','delivered') GROUP BY p.id ORDER BY n DESC, p.name LIMIT 8`).all();
  const body = top.length ? top.map((x, i) => `**${i+1}. ${x.name}** — ${x.n} purchase(s)`).join("\n") : "No products yet.";
  const e = embed("S2A DEV • Admin Dashboard", "Live store overview. Use the admin commands to manage products and orders.")
    .addFields(
      { name: "Confirmed orders", value: String(totalOrders), inline: true },
      { name: "Pending orders", value: String(pending), inline: true },
      { name: "Recorded revenue", value: formatPrice(revenue), inline: true },
      { name: "Open tickets", value: String(openTickets), inline: true },
      { name: "Best sellers", value: body }
    );
  const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
  // يطابق باللاحقة فتصحّ اللوحة القديمة (كانت معلنة باسم D7 Dev) بدل ما نكرّرها
  const old = messages?.find(m => m.author.id === client.user.id && /Admin Dashboard$/.test(m.embeds[0]?.title || ""));
  if (old) await old.edit({ embeds: [e] }).catch(() => {});
  else await channel.send({ embeds: [e] }).catch(() => {});
}

// ─────────── سجل الطلبات: إيمبد واحد لكل طلب ───────────
// روم الطلبات يجيب حالة الطلب، وكل تغيير حالة ينزل برسالته الخاصة
// (مو تعديل الرسالة السابقة، ومو لستة مجمّعة) عشان يظل الأرشيف واضح.
// label = الإنجليزي للوحة التحكم، label_ar = لرسائل السجل بالعربي
const ORDER_STATUS = {
  pending:   { label: "Pending",     label_ar: "بانتظار التأكيد", emoji: "⏳" },
  confirmed: { label: "In progress", label_ar: "قيد التنفيذ",     emoji: "🚚" },
  delivered: { label: "Completed",   label_ar: "تم التنفيذ",      emoji: "✅" },
  cancelled: { label: "Cancelled",   label_ar: "ملغى",            emoji: "❌" },
};

// order لازم يجي معه name / role_id / price / currency / user_id / status
function orderFeedEmbed(order, extra = {}) {
  const st = ORDER_STATUS[order.status] || { label_ar: order.status || "غير معروفة", emoji: "ℹ️" };
  // تاريخ هذا السطر: جمّدناه بأمر الصاحب ثم رجعناه بأمره الأخير — لما علم
  // أن الوصلة التي تُوصل التقييم للطلب كانت مقطوعة (زر product_rate لا يبنيه
  // أحد) فلم يصل التقييم أصلاً لا مكان. الوصلة أُصلحت الآن: التقييم يصل صف
  // الطلب عند تقييم العميل ويظهر مع أول رسالة حالة بعده، وما لم يصل بعد
  // يبقى «لم يتم التقييم» صراحةً لا تخميناً.
  const rating = order.rating ? `⭐ ${order.rating}/5` : "لم يتم التقييم";
  // رتبة المنتج بدل اسمه: الرتبة هي ما يحمله المشتري فعلاً، والاسم يتكرر معها
  // وحالة الطلب آخر سطر — آخر ما يقع عليه النظر بعد بقية التفاصيل
  return embed(`🛒 طلب #${order.id}`, [
    `**الرتبة:** ${order.role_id ? `<@&${order.role_id}>` : "بدون رتبة"}`,
    `**المشتري:** <@${order.user_id}>`,
    `**السعر:** ${formatPrice(order.price, order.currency)}`,
    `**التقييم:** ${rating}`,
    order.confirmed_by ? `**الاداري:** <@${order.confirmed_by}>` : "",
    extra.note ? `**ملاحظة:** ${extra.note}` : "",
    `**حالة الطلب:** ${st.emoji} ${st.label_ar}`,
  ].filter(Boolean).join("\n"));
}

// يجيب الطلب مع بيانات منتجه حتى يقدر يبني إيمبد السجل
function orderForFeed(id) {
  return db.prepare("SELECT o.*, p.name, p.role_id, p.price, p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?").get(id) || null;
}

// حذف رسالة حالة الطلب من الروم — حذف الصف وحده لا يكفي: تبقى الرسالة
// على أزرارها وتشير لطلب لم يعد موجوداً، فيجب أن تُحذف معه
async function removeOrderStatusMessage(guild, order) {
  if (!order?.status_msg_id) return;
  const key = safeChannelId(config.channels?.orderStatus) ? "orderStatus" : "orders";
  const channel = channelFromConfig(guild, key);
  const msg = channel?.messages?.fetch ? await channel.messages.fetch(order.status_msg_id).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => {});
}

// ─────────── أزرار تغيير حالة الطلب، داخل رسالة الحالة نفسها ───────────
// الترتيب ترتيب مرحلة الدورة لا ترتيب كتابة الطلب: معلق ← قيد التنفيذ ←
// تم التنفيذ، والإلغاء بجانبها. الزر المطابق للحالة الحالية معطّل: يبيّن
// أين الطلب الآن، ويمنع ضغطة لا تغيّر شيئاً.
const ORDER_STATUS_ACTIONS = [
  { key: "pending",   label: "⏳ معلق",        style: ButtonStyle.Secondary },
  { key: "confirmed", label: "🚀 قيد التنفيذ", style: ButtonStyle.Primary },
  { key: "delivered", label: "✅ تم التنفيذ",  style: ButtonStyle.Success },
  { key: "cancelled", label: "❌ ملغى",         style: ButtonStyle.Danger },
];

function statusPayload(order, extra) {
  return { embeds: [orderFeedEmbed(order, extra)], components: statusRows(order) };
}

function statusRows(order) {
  return [new ActionRowBuilder().addComponents(ORDER_STATUS_ACTIONS.map(a =>
    new ButtonBuilder()
      .setCustomId(`d7_order_status:${order.id}:${a.key}`)
      .setLabel(a.label)
      .setStyle(a.style)
      .setDisabled(order.status === a.key)))];
}

// الكتابة نفسها يستعملها الزر والأمر — حتى لا يختلف أثر الضغطة عن أثر الأمر
function setOrderStatus(order, next, staffId) {
  const id = order.id;
  if (next === "confirmed") {
    // COALESCE: تأكيد ثانٍ ما يمسح وقت التأكيد الأول ولا مَن قام به
    db.prepare("UPDATE orders SET status='confirmed',confirmed_at=COALESCE(confirmed_at,CURRENT_TIMESTAMP),confirmed_by=COALESCE(NULLIF(confirmed_by,''),?) WHERE id=?").run(staffId || "", id);
  } else if (next === "delivered") {
    const now = Date.now();
    const start = order.confirmed_at ? new Date(String(order.confirmed_at).replace(" ", "T") + "Z").getTime() : now;
    db.prepare("UPDATE orders SET status='delivered',delivered_at=CURRENT_TIMESTAMP,delivery_seconds=? WHERE id=?").run(Math.max(0, Math.floor((now - start) / 1000)), id);
  } else if (next === "cancelled") {
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
  } else {
    db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(id);
  }
  order.status = next;
  return order;
}

async function postOrderFeed(guild, order, extra) {
  // رسالة واحدة لكل طلب تتبدّل في مكانها. لو نشرنا رسالة جديدة مع كل تغيير
  // لتكدّست الرسائل ولضغط الموظف زراً في رسالة قديمة بحالة قديمة.
  // روم منفصل عن روم تسجيل الشراء: رسالة الشراء تسجّل الحدوث،
  // وهذي تتابع حالة الطلب (مؤكد / تم تسليمه / ملغى) — ما نخلطهم في مكان واحد.
  // ولو لم يُضبط روم الحالة بعد نرجع لروم الشراء بدل أن نفقد الرسالة:
  // إسقاطها بصمت أسوأ من أن تظهر في الروم المشترك، وهذا بالضبط ما حدث
  // سابقاً مع روم لم يكن في الكاش — الإشعار اختفى ولم يعترض أحد.
  const key = safeChannelId(config.channels?.orderStatus) ? "orderStatus" : "orders";
  const channel = channelFromConfig(guild, key);
  if (!channel?.isTextBased()) return false;
  const payload = statusPayload(order, extra);
  // نحدّث الرسالة إن عرفنا عنوانها — وإن لم تعد موجودة ننشر غيرها ونحدّث المؤشر
  if (order.status_msg_id && channel.messages?.fetch) {
    const old = await channel.messages.fetch(order.status_msg_id).catch(() => null);
    if (old) return !!(await old.edit(payload).catch(() => null));
  }
  const sent = await channel.send(payload).catch(() => null);
  if (!sent) return false;
  order.status_msg_id = String(sent.id);
  db.prepare("UPDATE orders SET status_msg_id=? WHERE id=?").run(order.status_msg_id, order.id);
  return true;
}

// ─────────── بعد كتابة التقييم: أعد رسم ما يعرضه ───────────
// رسالة حالة الطلب واللوحة المنشورة تقرؤان orders.rating وقت الرسم فقط،
// فكتابة التقييم وحدها لا تحرّك شيئاً على الشاشة: بقي "لم يتم التقييم"
// في رسالة الحالة و"no rating" في لوحة الإحصاءات رغم أن التقييم سُجّل.
async function repaintAfterRating(guild, orderId) {
  if (!guild || !orderId) return;
  try {
    const order = orderForFeed(Number(orderId));
    if (!order) return;
    // ما ننشر رسالة حالة جديدة لمطلب لم تُنشأ له — نُحيّن المنشورة فقط
    if (order.status_msg_id) await postOrderFeed(guild, order);
    await refreshOrdersPanel(guild).catch(() => {});
    await refreshAdminDashboard(guild).catch(() => {});
  } catch (err) {
    console.warn("repaintAfterRating: " + err.message);
  }
}

// ─────────── "شراء جديد" — نفس الشكل للمسارين ───────────
// المسار الأول: زر شراء (ينشئ طلباً بانتظار التأكيد). المسار الثاني: منح رتبة
// يدوياً ثم موافقة الموظف (ما يخلق طلباً) — لذلك لا نذكر رقماً غير موجود في الثاني.
// الشكل طلب المستخدم: المنتج = منشن الرتبة مو الاسم، والحقول إنجليزي،
// وحالة الطلب عربي بقيمة عربية.
function purchaseFeedEmbed(product, buyerId, opts = {}) {
  // المسارين يمرّران شكلين مختلفين: زر الشراء يمرّر صف قاعدة البيانات (role_id)
  // ومسار تأكيد الشراء يمرّر ناتج ratings.getProducts() المسمّى roleId.
  // بدون هذي المطابقة يظهر اسم المنتج بدل الرتبة في أحد المسارين بصمت.
  const roleId = product?.role_id || product?.roleId || "";
  const roleMention = roleId ? `<@&${roleId}>` : (product?.name || "Unknown");
  // رسالة تسجيل شراء فقط: هل وصلت الرتبة للشخص بالغلط ولا اشتراها فعلاً؟
  // حالة الطلب مو هنا — لها رسالة منفصلة في رومها الخاص (postOrderFeed)
  // لأن الوظيفتين مختلفتين: وحدة تسجّل حدوث شراء، والثانية تتابع تقدّم الطلب.
  return embed("🛒 New purchase", [
    `**Product**\n${roleMention}`,
    `**Buyer:**\n<@${buyerId}>`,
    `**Price:** ${formatPrice(product.price, product.currency)}`,
    opts.orderId ? `**Order:** #${opts.orderId}` : "",
    opts.approvedBy ? `**Admin:** <@${opts.approvedBy}>` : "",
    opts.note ? `**Note:** ${opts.note}` : "",
    // سطر فاضي بين المجموعات: كل حقل مجموعة (وسطر القيمة تحته)،
    // والحقول المكدّسة بدون فاصل تُقرأ سطراً واحداً طويلاً لا قائمة
  ].filter(Boolean).join("\n\n"));
}

async function postPurchaseFeed(guild, product, buyerId, opts) {
  // الإشعار مكمّل: لو الروم غير محدد يرجع false بصمت والتثبيت يظل قائماً
  return sendToConfiguredChannel(guild, "orders", { embeds: [purchaseFeedEmbed(product, buyerId, opts)] }).catch(() => false);
}

// ─────────── روم حالة المنتجات (داخل قسم الطلبات) ───────────
const PRODUCT_STATUS = {
  working:     { label: "Working",             emoji: "✅" },
  maintenance: { label: "Under maintenance", emoji: "🛠️" },
  stopped:     { label: "Stopped",            emoji: "⛔" },
};

// رسالة واحدة لكل تغيير حالة، ولا تنزل لو الحالة رجعت نفس ما كانت
function productStatusEmbed(product, from, to, by) {
  const t = PRODUCT_STATUS[to] || { label: to || "Unknown", emoji: "ℹ️" };
  const f = PRODUCT_STATUS[from] || { label: from || "Unknown", emoji: "ℹ️" };
  return embed(`${t.emoji} ${t.label} — ${product.name}`, [
    `**Product:** #${product.id} ${product.name}`,
    `**Status:** ${t.emoji} ${t.label}`,
    from && from !== to ? `**Previous:** ${f.emoji} ${f.label}` : "",
    `**Price:** ${formatPrice(product.price, product.currency)}`,
    `**Changed by:** ${by}`,
  ].filter(Boolean).join("\n"));
}

async function postProductStatus(guild, product, from, to, by) {
  // لو الروم غير محدد يرجع false بصمت — التغيير نفسه يظل محفوظاً في القاعدة
  return sendToConfiguredChannel(guild, "productStatus", { embeds: [productStatusEmbed(product, from, to, by)] }).catch(() => false);
}

// ─────────── تأكيد طلب: يعطي الرول وينبّه روم الطلبات ───────────
async function confirmOrder(interaction, id) {
  const order = db.prepare("SELECT o.*, p.name, p.role_id, p.price, p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?").get(id);
  if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
  if (order.status !== "pending") return interaction.reply({ content: `This order is already **${order.status}**.`, ephemeral: true });
  // ── اعتراف فوري قبل أي خطوة شبكة (جلب العضو، منح الرتبة، DM، سجل
  // الطلبات، اللوحة المنشورة، لوحة الإدارة): ديسكورد يمنح 3 ثوانٍ فقط،
  // والردّ المتأخر كان ينتهي بـ10062 Unknown interaction ويُسقِط البوت.
  const fromMessage = !!interaction.message?.components;
  if (fromMessage) await interaction.deferUpdate().catch(() => {});
  else await interaction.deferReply({ flags: 64 }).catch(() => {});
  const guild = interaction.guild;
  const member = await guild.members.fetch(order.user_id).catch(() => null);
  if (!member) return interaction.editReply({ content: "The buyer is not a member of this server." }).catch(() => {});
  if (order.role_id) {
    // تأكيد الدفع من الموظف نفسه → ما نطلب تأكيداً ثانياً قبل رسالة التقييم
    preApprove(order.user_id, order.product_id);
    await member.roles.add(order.role_id, `S2A DEV order #${id} confirmed`).catch(() => {});
  }
  db.prepare("UPDATE orders SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,confirmed_by=? WHERE id=?").run(interaction.user.id, id);
  order.status = "confirmed";
  order.confirmed_by = interaction.user.id;
  if (config.purchase.sendThankYouDM) {
    await member.send({ embeds: [embed("Thank you for your purchase!", `Your purchase of **${order.name}** has been confirmed.\nOrder: #${id}\nProduct role: ${order.role_id ? `<@&${order.role_id}>` : "No role configured"}`)] }).catch(() => {});
  }
  // رسالة التقييم ترسل من مستمع رتب المنتجات (أدناه) — نفس النضام المستخدم في NSR Hub
  // سجل الطلبات: رسالة جديدة للطلب تبيّن اسم المنتج ورتبته وسعره وحالته ومشتريه وتقييمه
  await postOrderFeed(guild, order);
  await refreshAdminDashboard(guild);
  // اللوحة المنشورة تتحرك معنا، والردّ بعدها هو الكتابة الأخيرة
  // (لو كانت الشاشة الحالية هي اللوحة نفسها تُحدَّث بتأكيد النجاح).
  await refreshOrdersPanel(guild).catch(() => {});
  const okMsg = `✅ Confirmed order #${id} and granted ${member} the **${order.name}** role.`;
  if (fromMessage) return interaction.editReply(ordersPanelPayload(interaction, okMsg)).catch(() => {});
  return interaction.editReply({ content: okMsg }).catch(() => {});
}

// ─────────── إضافة منتج: الرتبة ← السعر ← الاسم ───────────
function productRoleStep() {
  return {
    embeds: [embed("🛍️ Add Product", "**Pick a role**\nThe role is granted to the customer once payment is confirmed.")],
    components: [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId("d7_prod_role").setPlaceholder("Pick a role").setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("d7_prod_role_skip").setLabel("No role").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("d7_prod_role_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

function productPriceModal() {
  const modal = new ModalBuilder().setCustomId("panel_modal:add-price").setTitle("Set the price");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("price").setLabel("Price").setPlaceholder("e.g. 150 or 150.50")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
  ));
  return modal;
}

function productNameModal() {
  const modal = new ModalBuilder().setCustomId("panel_modal:add-name").setTitle("Product name");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("name").setLabel("Product name").setPlaceholder("e.g. Dev Pack")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
  ));
  return modal;
}

// بعد اختيار الرتبة → نافذة السعر (أو الاسم مباشرة لو السعر معطوف في الأمر)
function productAfterRole(interaction) {
  const pending = pendingProduct.get(interaction.user.id);
  if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
  if (pending.price === null) return interaction.showModal(productPriceModal());
  if (pending.name === null) return interaction.showModal(productNameModal());
  return finishProduct(interaction);
}

function productNameStep() {
  return {
    content: "✅ Price saved. Press below to enter the product name:",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_prod_name_step").setLabel("📝 Product name").setStyle(ButtonStyle.Primary)
    )],
  };
}

function startProductFlow(interaction, { name = null, price = null, ephemeral = true } = {}) {
  pendingProduct.set(interaction.user.id, { name, price, roleId: "" });
  return interaction.reply({ ...productRoleStep(), ephemeral });
}

// ─────────── حفظ المنتج بعد اكتمال الخطوات ───────────
async function finishProduct(interaction) {
  const pending = pendingProduct.get(interaction.user.id);
  if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
  pendingProduct.delete(interaction.user.id);
  const name = String(pending.name || "").trim();
  const price = Number(pending.price);
  if (!name) return interaction.reply({ content: "❌ A product name is required.", ephemeral: true });
  if (!Number.isFinite(price) || price < 0) return interaction.reply({ content: "The price must be a number, e.g. 150 or 150.50", ephemeral: true });
  const res = db.prepare("INSERT INTO products (name,price,role_id) VALUES (?,?,?)").run(name, price, pending.roleId || "");
  const message = `✅ Added product **${name}** as \`#${res.lastInsertRowid}\` — ${formatPrice(price)}${pending.roleId ? `\nRole: <@&${pending.roleId}>` : "\nNo role"}`;
  return respondWith(interaction, { ...productsSection(), content: message });
}

// ─────────── تأكيد الشراء قبل إرسال رسالة التقييم ───────────
// أي عضو ياخذ رتبة أي منتج → نطلب تأكيد من الموظفين في روم التأكيدات:
//   ✅ تأكيد  → توصله رسالة التقييم
//   ❌ رفض    → ما يوصله شي (كأنه ما جاتته الرتبة أصلاً)
// إذا ما كان روم التأكيدات محدد، نرسل رسالة التقييم مباشرة حتى لا يتوقف النظام.
const lastRatingDm = new Map();
const RATING_DM_COOLDOWN = 60 * 60 * 1000; // ساعة

// طلب تأكيد يُنشأ تلقائياً من طرف الموظف نفسه (تأكيد الدفع من اللوحة)
const preApproved = new Set();
function preApprove(userId, productId) {
  const key = `${userId}:${productId}`;
  preApproved.add(key);
  setTimeout(() => preApproved.delete(key), 15000);
}

function purchaseCheckChannel(guild) {
  return channelFromConfig(guild, "purchaseChecks");
}

async function requestPurchaseCheck(member, product) {
  if (!member?.user || member.user.bot) return;
  if (config.purchase?.sendProductReviewDM === false) return;
  if (!product) return;

  const key = `${member.id}:${product.id}`;
  const last = lastRatingDm.get(key) || 0;
  if (Date.now() - last < RATING_DM_COOLDOWN) return;

  // الموظف أكّد الدفع من اللوحة → ما نطلب تأكيد ثاني، نرسل التقييم مباشرة
  if (preApproved.delete(key)) {
    lastRatingDm.set(key, Date.now());
    await ratings.sendPurchaseDM(member.user, product, client, member.guild);
    return;
  }

  const channel = purchaseCheckChannel(member.guild);
  // ما فيه روم تأكيدات محدد → نرسل مباشرة (حتى لا يتوقف النظام)
  if (!channel?.isTextBased()) {
    lastRatingDm.set(key, Date.now());
    await ratings.sendPurchaseDM(member.user, product, client, member.guild);
    return;
  }

  // طلب قيد الانتظار لنفس العضو والمنتج → ما نكرر الرسالة
  if (db.purchaseChecks.pendingFor(member.id, product.id)) return;

  const check = db.purchaseChecks.create({
    guildId: member.guild.id,
    userId: member.id,
    productId: product.id,
    channelId: channel.id,
  });
  const payload = purchaseCheckPayload(check.lastInsertRowid, member.id, product, "pending");
  const sent = await channel.send(payload).catch(err => {
    console.error("Purchase check post failed:", err.message);
    return null;
  });
  if (sent) db.purchaseChecks.linkMessage(check.lastInsertRowid, sent.id);
}

// حمولة رسالة التأكيد — تُستخدم عند الإنشاء وعند تحديث الحالة
function purchaseCheckPayload(id, userId, product, status, decidedBy) {
  const badge = status === "approved" ? "✅ **Confirmed** — the rating DM was sent."
    : status === "rejected" ? "❌ **Rejected** — nothing was sent."
    : "⏳ **Awaiting confirmation** — did this member really buy the product?";
  const rows = status === "pending"
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`d7_pcheck:${id}:ok`).setLabel("✅ Confirm").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`d7_pcheck:${id}:no`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      )]
    : [];
  return {
    embeds: [embed("🛒 Product Purchase Check", [
      `**Member:** <@${userId}>`,
      `**Product:** ${product?.name || "Unknown"}${product?.name ? ` — ${formatPrice(product.price, product.currency)}` : ""}`,
      "",
      badge,
      decidedBy ? `**By:** <@${decidedBy}>` : "",
    ].filter(Boolean).join("\n"))],
    components: rows,
  };
}

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (!newMember?.user) return;
  // الرتب المضافة فقط: اللي موجودة عند الجديد ومو موجودة عند القديم
  for (const role of newMember.roles.cache.values()) {
    if (!oldMember?.roles?.cache?.has(role.id)) {
      requestPurchaseCheck(newMember, ratings.getByRole(role.id)).catch(err => console.error("Purchase check failed:", err.message));
    }
  }
});

client.once(Events.ClientReady, async c => {
  console.log(`S2A DEV bot online as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) await refreshAdminDashboard(guild);
});

client.on(Events.GuildMemberAdd, async member => {
  // Configurable automatic roles: separate roles for human members and bots.
  if (config.autoRoles?.enabled) {
    const roleId = member.user.bot ? config.autoRoles.botRoleId : config.autoRoles.memberRoleId;
    if (roleId && member.guild.roles.cache.has(roleId)) {
      await member.roles.add(roleId, "S2A DEV automatic join role").catch(err => console.error("Auto-role assignment failed:", err.message));
    }
  }
  if (!config.welcome?.enabled) return;

  // وضع الخاص (الافتراضي والمضبوط حالياً): نص عادي للعضو فقط.
  // طلب الصاحب: لا إيمبد في الخاص، ولا شيء إطلاقاً في روم الترحيب —
  // زار "الاحتياطي" السابق كان ينشر إيمبد الروم كلما انضم لاعب خاصه مقفول.
  if (config.welcome.sendDM !== false) {
    await member.send(welcomeDMPayload()).catch(() => {});
    return;
  }

  // وضع روم الترحيب: إيمبد في الروم مباشرة مع منشن المنضم.
  const channel = channelFromConfig(member.guild, "welcome");
  if (!channel?.isTextBased()) return;
  await channel.send({ ...welcomePayload(), content: `<@${member.id}>` }).catch(() => {});
});

async function handleInteraction(interaction) {
  try {
    // ─────────── إكمال أمر /rate (اسم المنتج مع قائمة مقترحة) ───────────
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "rate") {
        const q = interaction.options.getFocused().toLowerCase();
        const prods = ratings.getProducts().filter(p => p.name.toLowerCase().includes(q)).slice(0, 25);
        return interaction.respond(prods.map(p => ({ name: p.name, value: p.id })));
      }
      return interaction.respond([]);
    }

    if (interaction.isChatInputCommand()) {
      // ─────────── كل الأوامر للمديرين فقط (طلب المالك الصريح) ───────────
      // نافذة ديسكورد تخفي الأوامر عن غيرهم (default_member_permissions)،
      // وهذا السطر يمنع التنفيذ نفسه حتى لو وصل الأمر بحيلة. قائمة المالك
      // (adminUserIds) تمر أيضًا — شبكة أمان كي لا تُفقد صلاحيتك عن غير قصد.
      const isAdmin = !!interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)
        || (config.permissions?.adminUserIds || []).includes(interaction.user.id);
      if (!isAdmin) return interaction.reply({ content: "🔒 This bot's commands are limited to administrators.", ephemeral: true });

      const { commandName } = interaction;
      if (commandName === "panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        return interaction.reply({ ...mainPanel(), ephemeral: true });
      }
      // /panel2 — اللوحة نفسها لكن غير خاصة: ردٌّ عادي يبقى في الروم ويراه
      // الجميع ولا يختفي، وأزراره تعمل كأي لوحة منشورة (زر Home يعود إليها)
      if (commandName === "panel2") {
        return interaction.reply({ ...mainPanel() });
      }
      if (commandName === "ticket-panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        return interaction.reply({ embeds: [tickets.panelEmbed()], components: tickets.panelRows() });
      }
      if (commandName === "products") {
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        if (!products.length) return interaction.reply({ content: "No products added yet.", ephemeral: true });
        return interaction.reply({ embeds: products.slice(0, 10).map(productEmbed), ephemeral: true });
      }
      if (commandName === "product-add") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const name = interaction.options.getString("name");
        const price = interaction.options.getNumber("price");
        return startProductFlow(interaction, { name, price });
      }
      if (commandName === "rate") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const target = interaction.options.getUser("user", true);
        if (!target || target.bot) return interaction.reply({ content: "❌ Pick a real customer, not a bot.", ephemeral: true });
        const all = ratings.getProducts();
        if (!all.length) return interaction.reply({ content: "❌ No products yet — add one from the panel first.", ephemeral: true });
        const raw = interaction.options.getString("product", true);
        const product = ratings.findProduct(interaction.guildId, raw);
        if (!product) return interaction.reply({ content: "❌ Product not found. Available products:\n" + all.map(p => `• **${p.name}**`).join("\n"), ephemeral: true });
        const ok = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
        if (!ok) return interaction.reply({ content: `❌ Could not DM ${target} — their DMs may be closed.`, ephemeral: true });
        return interaction.reply({ content: `✅ Sent the **${product.name}** rating DM to ${target}.`, ephemeral: true });
      }
      if (commandName === "product-edit") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = interaction.options.getInteger("id", true);
        const status = interaction.options.getString("status", true);
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(id);
        if (!product) return interaction.reply({ content: "Product not found.", ephemeral: true });
        const before = product.status;
        db.prepare("UPDATE products SET status=? WHERE id=?").run(status, id);
        // روم حالة المنتجات: رسالة لكل تغيير حالة فقط — لو الحالة كما هي ما نكتب شي
        if (before !== status) await postProductStatus(interaction.guild, product, before, status, interaction.user);
        return interaction.reply({ content: `Updated **${product.name}** status to **${status}**.`, ephemeral: true });
      }
      if (commandName === "product-panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        if (!products.length) return interaction.reply({ content: "Add products first using /product-add.", ephemeral: true });
        return interaction.reply({
          embeds: [embed("🛍️ Publish Products", `${Math.min(products.length, 10)} product(s).\nPick the channel to publish them in.`)],
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
            .setCustomId("d7_showcase_channel").setPlaceholder("Pick the showcase channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1))],
        });
      }
      if (commandName === "order-create") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const user = interaction.options.getUser("customer", true);
        const productId = interaction.options.getInteger("product_id", true);
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
        if (!product) return interaction.reply({ content: "Product not found.", ephemeral: true });
        const result = db.prepare("INSERT INTO orders (guild_id,user_id,product_id) VALUES (?,?,?)").run(interaction.guildId, user.id, productId);
        // اعتراف قبل تحديث اللوحة (شبكة) — ديسكورد يمنح 3 ثوانٍ فقط
        await interaction.deferReply({ flags: 64 }).catch(() => {});
        await refreshOrdersPanel(interaction.guild).catch(() => {});
        return interaction.editReply({ content: `Order #${result.lastInsertRowid}\nCustomer: ${user}\nProduct: **${product.name}**\nUse /order-confirm to confirm payment and grant the product role.` }).catch(() => {});
      }
      if (commandName === "order-confirm") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        return confirmOrder(interaction, interaction.options.getInteger("order_id", true));
      }
      if (commandName === "order-deliver") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = interaction.options.getInteger("order_id", true);
        const order = orderForFeed(id);
        if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
        if (order.status === "cancelled") return interaction.reply({ content: `Order #${id} is cancelled and cannot be delivered.`, ephemeral: true });
        if (order.status === "delivered") return interaction.reply({ content: `Order #${id} was already delivered.`, ephemeral: true });
        const now = Date.now();
        const start = order.confirmed_at ? new Date(order.confirmed_at.replace(" ", "T") + "Z").getTime() : now;
        db.prepare("UPDATE orders SET status='delivered',delivered_at=CURRENT_TIMESTAMP,delivery_seconds=? WHERE id=?").run(Math.max(0, Math.floor((now-start)/1000)), id);
        order.status = "delivered";
        // اعتراف قبل رسائل السجل واللوحات (شبكة كلها)
        await interaction.deferReply({ flags: 64 }).catch(() => {});
        // رسالة جديدة في سجل الطلبات تبيّن إن الحالة صارت "تم التنفيذ"
        await postOrderFeed(interaction.guild, order);
        await refreshOrdersPanel(interaction.guild).catch(() => {});
        await refreshAdminDashboard(interaction.guild);
        return interaction.editReply({ content: `Order #${id} marked as delivered.` }).catch(() => {});
      }
      if (commandName === "order-cancel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = interaction.options.getInteger("order_id", true);
        const order = orderForFeed(id);
        if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
        if (order.status === "cancelled") return interaction.reply({ content: `Order #${id} is already cancelled.`, ephemeral: true });
        const note = (interaction.options.getString("reason") || "").trim();
        db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
        order.status = "cancelled";
        // ما نسحب رول المنتج تلقائياً — الإلغاء يوثّق الحالة بس، والسحب قرار موظف
        await interaction.deferReply({ flags: 64 }).catch(() => {});
        await postOrderFeed(interaction.guild, order, { note: note || undefined });
        await refreshOrdersPanel(interaction.guild).catch(() => {});
        await refreshAdminDashboard(interaction.guild);
        return interaction.editReply({ content: `Order #${id} cancelled.${order.role_id ? ` Note: the product role <@&${order.role_id}> was not removed.` : ""}` }).catch(() => {});
      }
      if (commandName === "orders") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const rows = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
        const description = rows.length ? rows.map(o => `**#${o.id} — ${o.product_name}**\nCustomer: <@${o.user_id}> • ${o.status} • ${o.created_at}${o.delivery_seconds !== null ? ` • ${Math.floor(o.delivery_seconds/60)}m ${o.delivery_seconds%60}s` : ""}\nRating: ${o.rating ? `${o.rating}/5` : "Not rated"}`).join("\n\n") : "No orders yet.";
        return interaction.reply({ embeds: [embed("Recent Orders", description)], ephemeral: true });
      }
      if (commandName === "dashboard-refresh") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        await interaction.deferReply({ flags: 64 }).catch(() => {});
        await refreshAdminDashboard(interaction.guild);
        return interaction.editReply({ content: "Dashboard refreshed where configured." }).catch(() => {});
      }
      if (commandName === "embed-send") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const channel = interaction.options.getChannel("channel", true);
        const title = interaction.options.getString("title", true);
        const description = interaction.options.getString("description", true);
        const image = interaction.options.getString("image") || "";
        const e = embed(title, description);
        if (image) e.setImage(image);
        await channel.send({ embeds: [e] });
        return interaction.reply({ content: "Embed sent.", ephemeral: true });
      }
      if (commandName === "post-message") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const kind = interaction.options.getString("kind", true);
        const title = interaction.options.getString("title", true);
        const body = interaction.options.getString("message", true);
        const image = interaction.options.getString("image") || "";
        const channelKey = ({news:"news",rules:"rules",update:"updates"})[kind];
        const channel = channelKey ? channelFromConfig(interaction.guild, channelKey) : null;
        if (!channel?.isTextBased()) return interaction.reply({ content: `Configure the ${kind} channel ID in config.json first.`, ephemeral: true });
        const e = embed(title, body);
        if (image) e.setImage(image);
        await channel.send({ embeds: [e] });
        return interaction.reply({ content: `${kind} posted in ${channel}.`, ephemeral: true });
      }
      if (commandName === "stats") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const productStats = db.prepare(`SELECT p.name,COUNT(o.id) count,COALESCE((SELECT AVG(r.stars) FROM ratings r WHERE r.product_id=p.id),0) avg FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.status IN ('confirmed','delivered') GROUP BY p.id ORDER BY count DESC`).all();
        const desc = productStats.length ? productStats.map(p => `**${p.name}** — ${p.count} purchase(s) • ${(p.avg || 0).toFixed(1)}/5`).join("\n") : "No products yet.";
        return interaction.reply({ embeds: [embed("Product Analytics", desc)], ephemeral: true });
      }
      // ─────────── قفل/فتح الروم الحالي ───────────
      // /close يمنع الإرسال والثريدات على @everyone
      // /open يرجعها للوضع الطبيعي (null = لا مسموح ولا ممنوع) — مو يحطها مسموحة
      if (commandName === "close" || commandName === "open") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const isClose = commandName === "close";
        const value = isClose ? false : null;
        const channel = interaction.channel;
        if (!channel?.permissionOverwrites) {
          return interaction.reply({ content: "❌ هذا الروم ما يدعم تغيير الصلاحيات.", ephemeral: true });
        }
        try {
          await channel.permissionOverwrites.edit(interaction.guild.id, {
            SendMessages: value,
            SendMessagesInThreads: value,
            CreatePublicThreads: value,
            CreatePrivateThreads: value,
          });
        } catch (err) {
          return interaction.reply({ content: `❌ تعذر ${isClose ? "قفل" : "فتح"} الروم: ${err.message}`, ephemeral: true });
        }
        const title = isClose ? "🔒 تم قفل الروم" : "🔓 تم فتح الروم";
        const body = [
          `**الروم:** <#${channel.id}>`,
          isClose
            ? "الرسائل والثريدات ممنوعة الآن للجميع."
            : "رجعت الصلاحيات للوضع الطبيعي (لا مسموح ولا ممنوع).",
        ].join("\n");
        return interaction.reply({ embeds: [embed(title, body)] });
      }
      if (commandName === "welcome-set") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const message = interaction.options.getString("message", true);
        const image = interaction.options.getString("image") || "";
        const file = path.join(__dirname, "..", "config.json");
        config.welcome.message = message;
        config.welcome.imageUrl = image;
        fs.writeFileSync(file, JSON.stringify(config, null, 2));
        return interaction.reply({ content: "Welcome message and image saved in config.json.", ephemeral: true });
      }
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("autorole_select:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
      const target = interaction.customId.split(":")[1];
      // القيم الفارغة (اختيار صفر رتبة) = مسح الرتبة المحفوظة
      const roleId = interaction.values[0] || "";
      if (target === "member") config.autoRoles.memberRoleId = roleId;
      else if (target === "bot") config.autoRoles.botRoleId = roleId;
      saveConfig();
      return interaction.update(autorolesSection(roleId
        ? `✅ Saved the ${target === "member" ? "member" : "bot"} role: <@&${roleId}>.`
        : `🗑️ Cleared the ${target === "member" ? "member" : "bot"} role.`));
    }

    if (interaction.isButton()) {
      const [action, ...parts] = interaction.customId.split(":");
      if (action === "panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const section = parts[0];
        if (section === "products") return interaction.update(productsSection());
        if (section === "add-product") {
          pendingProduct.set(interaction.user.id, { name: null, price: null, roleId: "" });
          return respondWith(interaction, productRoleStep());
        }
        if (section === "publish-products") {
          const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
          if (!products.length) return interaction.reply({ content: "Add products first from the Products section.", ephemeral: true });
          return interaction.reply({ content: "Pick the channel to publish the products in:", components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("d7_showcase_channel").setPlaceholder("Pick the showcase channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1))] });
        }
        if (section === "products-list") return interaction.update(productsSection());
        if (section === "delete-product") {
          const rows = productDeleteRows();
          if (!rows) return interaction.reply({ content: "There are no products to delete.", ephemeral: true });
          return interaction.update({
            embeds: [embed("🗑️ Delete Product", "**Pick a product from the menu below.**\n⚠️ Deletion is permanent and cannot be undone.\nProducts with recorded orders cannot be deleted, to protect the sales history.")],
            components: rows,
          });
        }
        if (section === "orders") {
          const flag = parts[1];
          if (flag === "del") {
            const delRows = orderDeleteRows();
            if (!delRows) return interaction.reply({ content: "There are no orders to delete.", ephemeral: true });
            // ⚠️ Delete All انتقل إلى هنا من صف أزرار اللوحة (خُمسة صفوفه
            // كانت ستة أزرار) — وهذا مكانه الطبيعي: شاشة الحذف.
            return interaction.update({
              embeds: [embed("🗑️ Delete Order", "**Pick an order from the menu below.**\n⚠️ Deletion is permanent — the order **and its status message** are removed.")],
              components: [...delRows, new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("panel:orders:delall").setLabel("⚠️ Delete All").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
              )],
            });
          }
          if (flag === "publish") return interaction.update(ordersPublishView());
          if (flag === "view") {
            const viewRows = orderPickRows("d7_order_view_sel", "Pick an order to see its full details...");
            if (!viewRows) return interaction.reply({ content: "There are no orders to view yet.", ephemeral: true });
            return interaction.update({
              embeds: [embed("👁️ View Order Details", "**Pick an order from the menu below.**\nYou'll get its full card: who ordered it, who the admin is, the product, the role, the price, every timestamp, the rating and the review.")],
              components: [...viewRows, new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
              )],
            });
          }
          if (flag === "edit") {
            const editRows = orderPickRows("d7_order_edit_sel", "Select the order to edit its status...");
            if (!editRows) return interaction.reply({ content: "There are no orders to edit.", ephemeral: true });
            return interaction.update({
              embeds: [embed("✏️ Edit Order", "**Pick an order from the menu below.**\nYou'll get its four status buttons — pick one and the order, its status message and this list all move together.")],
              components: [...editRows, new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("panel:orders").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary),
              )],
            });
          }
          if (flag === "delall") {
            const n = Number(db.prepare("SELECT COUNT(*) c FROM orders").get().c);
            if (!n) return interaction.reply({ content: "There are no orders to delete.", ephemeral: true });
            // خطوتان لا واحدة: مسح كل السجل خطوة لا رجعة فيها، فلا يُنفَّذ
            // بضغطة واحدة سهو — نفس فكرة "اضغط مرتين للتأكيد"
            return interaction.update({
              embeds: [embed("⚠️ Delete ALL orders?", [
                `This permanently deletes **${n} order(s)** and their status messages.`,
                "Numbering restarts at **#1** after the wipe.",
                "",
                "Press **Confirm** to proceed — or **Cancel** to go back.",
              ].join("\n"))],
              components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("panel:orders:wipe").setLabel(`⚠️ Confirm — delete ${n} orders`).setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("panel:orders").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
              )],
            });
          }
          if (flag === "wipe") {
            const all = db.prepare("SELECT * FROM orders WHERE status_msg_id<>''").all();
            // الصفوف أولاً (محلي، أ milliseconds) ثم الردّ ثم شبكة الحذف —
            // لو عكسنا الترتيب لتجمّد الرد وراء ثلاثين جلب رسالة وانتهت المهلة
            db.prepare("DELETE FROM orders").run();
            db.prepare("DELETE FROM sqlite_sequence WHERE name='orders'").run();
            // الردّ أولًا (شبكة بعده لا قبله)، ثم اللوحة المنشورة ثم الحذف
            await respondWith(interaction, ordersPanelPayload(interaction, "✅ All orders deleted — numbering restarts at #1.")).catch(() => {});
            await refreshOrdersPanel(interaction.guild).catch(() => {});
            const key = safeChannelId(config.channels?.orderStatus) ? "orderStatus" : "orders";
            const channel = channelFromConfig(interaction.guild, key);
            if (channel?.messages?.fetch) {
              for (const o of all.slice(0, 30)) {
                const m = await channel.messages.fetch(o.status_msg_id).catch(() => null);
                if (m) await m.delete().catch(() => {});
              }
            }
            return;
          }
          return interaction.update(ordersPanelPayload(interaction));
        }
        if (section === "tickets") return interaction.update(ticketsSection());
        if (section === "rulebook") {
          const flag = parts[1];
          const book = ensureRules();
          if (flag === "publish") return interaction.update(rulesPublishView());
          if (flag === "settings") return interaction.showModal(rulesSettingsModal());
          if (flag === "add") return interaction.showModal(rulesSectionModal(null));
          if (flag === "editlist") return interaction.update(rulesPickView("edit"));
          if (flag === "dellist") return interaction.update(rulesPickView("del"));
          if (flag === "delask") {
            const ask = book.sections.find(s => s.id === parts[2]);
            if (!ask) return interaction.reply({ content: "❌ That section no longer exists.", ephemeral: true });
            return interaction.update(rulesDeleteConfirm(ask));
          }
          if (flag === "edit") {
            const sec = book.sections.find(s => s.id === parts[2]);
            if (!sec) return interaction.reply({ content: "❌ That section no longer exists.", ephemeral: true });
            return interaction.showModal(rulesSectionModal(sec));
          }
          if (flag === "del") {
            const idx = book.sections.findIndex(s => s.id === parts[2]);
            if (idx < 0) return interaction.reply({ content: "❌ That section no longer exists.", ephemeral: true });
            const [gone] = book.sections.splice(idx, 1);
            saveConfig();
            // الردّ أولًا (اعتراف بالضغط) ثم تحديث الرسالة المنشورة خلفه
            await interaction.update(rulesSection(`🗑️ Removed **${gone.name}** — the published message was updated too.`)).catch(() => {});
            await refreshRulesMessage(interaction.guild).catch(() => {});
            return;
          }
          return interaction.update(rulesSection());
        }
        if (section === "channels") return interaction.update(channelsSection());
        if (section === "ratings") return interaction.update(ratingsSection());
        if (section === "store") {
          config.purchase ||= {};
          const flag = parts[1];
          if (flag === "manual") config.purchase.manualConfirmation = config.purchase.manualConfirmation === false;
          if (flag === "thankyou") config.purchase.sendThankYouDM = config.purchase.sendThankYouDM !== true;
          if (flag === "reviewdm") config.purchase.sendProductReviewDM = config.purchase.sendProductReviewDM !== true;
          if (flag) saveConfig();
          return interaction.update(storeSection());
        }
        if (section === "perms") return interaction.update(permsSection());
        if (section === "ticket-stats") return interaction.update(ticketStatsSection());
        if (section === "publish-tickets") {
          const enabled = tickets.types().filter(x => x.enabled !== false);
          if (!enabled.length) return interaction.reply({ content: "❌ No ticket types are enabled — enable at least one from Ticket Settings.", ephemeral: true });
          try {
            await interaction.channel.send({ embeds: [tickets.panelEmbed()], components: tickets.panelRows() });
          } catch (err) {
            return interaction.reply({ content: `❌ Could not send in this channel.\nMake sure the bot has **Send Messages** here.\n\n\`${err.message}\``, ephemeral: true });
          }
          return interaction.reply({ content: `✅ Ticket panel sent to <#${interaction.channel.id}>!`, ephemeral: true });
        }
        if (section === "content") {
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:news").setLabel("Post News").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:rules").setLabel("Post Rules").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("panel:update").setLabel("Post Update").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("panel:embed").setLabel("Custom Embed").setStyle(ButtonStyle.Secondary));
          return interaction.update({ embeds: [embed("Control Center · Messages", "Choose the message type to create. Images are optional; use a direct image URL.")], components: [row] });
        }
        if (["news","rules","update","embed"].includes(section)) {
          const modal = new ModalBuilder().setCustomId(`panel_modal:${section}`).setTitle(section === "embed" ? "Create Custom Embed" : `Post ${section}`);
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("body").setLabel("Message / Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Direct image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel").setLabel("Channel ID (custom embed only)").setStyle(TextInputStyle.Short).setRequired(section === "embed").setMaxLength(25)));
          return interaction.showModal(modal);
        }
        if (section === "analytics") {
          const productStats = db.prepare(`SELECT p.name,COUNT(o.id) count,COALESCE((SELECT AVG(r.stars) FROM ratings r WHERE r.product_id=p.id),0) avg FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.status IN ('confirmed','delivered') GROUP BY p.id ORDER BY count DESC`).all();
          const desc = productStats.length ? productStats.map(p => `**${p.name}** — ${p.count} purchase(s) · ${(p.avg || 0).toFixed(1)}/5`).join("\n") : "No products yet.";
          return interaction.update({ embeds: [embed("Control Center · Analytics", desc)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Admin Dashboard").setStyle(ButtonStyle.Success))] });
        }
        if (section === "welcome") {
          const flag = parts[1];
          if (flag === "toggle") {
            ensureWelcome();
            config.welcome.enabled = config.welcome.enabled === false;
            saveConfig();
            return interaction.update(welcomeSection(config.welcome.enabled
              ? "✅ Welcome message on — it is DM'd when a member joins."
              : "❌ Welcome message off — nothing is sent to new members."));
          }
          if (flag === "mode") {
            ensureWelcome();
            config.welcome.sendDM = config.welcome.sendDM === false;
            saveConfig();
            return interaction.update(welcomeSection(config.welcome.sendDM
              ? "📨 The welcome message is sent to the member as a plain text DM — nothing is posted in the welcome channel."
              : "🗨️ The welcome message is posted directly in the **welcome channel** set from the Channels section."));
          }
          if (flag === "text") {
            const w = ensureWelcome();
            const modal = new ModalBuilder().setCustomId("panel_modal:welcome_text").setTitle("Welcome message text");
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Title (Welcome to ...)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(String(w.title || ""))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("body").setLabel("Body").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000).setValue(String(w.message || ""))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("footer").setLabel("Footer under the image (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(String(w.footer || ""))),
              // حقل الصورة انتقل إلى هنا (كانت نافذة مستقلة) — حذفنا زرها
              // من اللوحة ليخترق صف الأزرار الخمسة الذي حدّه ديسكورد
              new ActionRowBuilder().addComponents(// تسمية الحقل 45 حرفاً كحد أقصى عند ديسكورد — الوصف الأطول كان يُفشل النافذة
              // كلها بـ ExpectedConstraintError قبل أن تُفتح أصلاً
              new TextInputBuilder().setCustomId("url").setLabel("Image URL (optional — keeps current)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(String(w.imageUrl || ""))),
            );
            return interaction.showModal(modal);
          }
          if (flag === "image") {
            const w = ensureWelcome();
            const modal = new ModalBuilder().setCustomId("panel_modal:welcome_image").setTitle("Welcome image");
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("url").setLabel("Direct image URL (shown, never as link text)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(String(w.imageUrl || ""))),
            );
            return interaction.showModal(modal);
          }
          if (flag === "intro-edit") {
            const i = ensureIntro();
            const modal = new ModalBuilder().setCustomId("panel_modal:intro_edit").setTitle("Edit the pinned welcome");
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(String(i.title || ""))),
              // سطر فارغ بين الفقرات = فقرة جديدة في الإيمبد (نفس شكل الأصل)
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("text").setLabel("Message — blank line = new paragraph").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(String(i.text || ""))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Image URL (optional — clears it if empty)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(String(i.image || ""))),
            );
            return interaction.showModal(modal);
          }
          if (flag === "send") {
            // رسالة ترحيب تُنشر بأمر الموظف لا بانضمام عضو — تذهب لروم الترحيب
            // نفسه الذي تُنشر فيه رسالة الانضمام احتياطاً، فيبقى المحتوى في مكان واحد
            const channel = channelFromConfig(interaction.guild, "welcome");
            if (!channel?.isTextBased()) return interaction.reply({ content: "⚠️ Set the welcome channel first — **Channels** section → 👋 Welcome channel.", ephemeral: true });
            const sent = await channel.send(welcomeIntroPayload()).catch(() => null);
            // نحفظ معرّف الرسالة المنشورة: أي تعديل لاحق على النص أو الصورة
            // يعيد رسمها في مكانها بدل نسخة جديدة فوق القديمة
            if (sent?.id) {
              const intro = ensureIntro();
              intro.channelId = String(channel.id);
              intro.messageId = String(sent.id);
              saveConfig();
            }
            return interaction.reply(sent
              ? { content: `✅ The welcome message was posted in <#${channel.id}>.`, ephemeral: true }
              : { content: "⚠️ Could not post it there - check that I can send messages in that channel.", ephemeral: true });
          }
          // زر التجربة → شاشة اختيار عضو، والنتيجة تظهر بعد الإرسال
          if (flag === "test") return interaction.update(welcomeTestView());
          return interaction.update(welcomeSection());
        }
        if (section === "autoroles") return interaction.update(autorolesSection());
        if (section === "autoroles-toggle") {
          config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
          config.autoRoles.enabled = !config.autoRoles.enabled;
          saveConfig();
          return interaction.update(autorolesSection(config.autoRoles.enabled ? "✅ Auto Roles on — granted when a new member joins." : "❌ Auto Roles off."));
        }
        if (section === "home") return interaction.update(mainPanel());
        if (section === "refresh") {
          await refreshAdminDashboard(interaction.guild);
          return interaction.reply({ content: "Admin dashboard refreshed where configured.", ephemeral: true });
        }
      }
      if (action === "product_info") {
        const p = db.prepare("SELECT * FROM products WHERE id=?").get(Number(parts[0]));
        if (!p) return interaction.reply({ content: "Product not found.", ephemeral: true });
        return interaction.reply({ embeds: [productEmbed(p)], ephemeral: true });
      }
      if (action === "buy_request") {
        const p = db.prepare("SELECT * FROM products WHERE id=?").get(Number(parts[0]));
        if (!p) return interaction.reply({ content: "Product not found.", ephemeral: true });
        if (p.status !== "working") return interaction.reply({ content: `This product is currently ${p.status}. Please contact support.`, ephemeral: true });
        const result = db.prepare("INSERT INTO orders (guild_id,user_id,product_id) VALUES (?,?,?)").run(interaction.guildId, interaction.user.id, p.id);
        // الاعتراف أولاً (كل ما بعده شبكة، وديسكورد يمنح 3 ثوانٍ فقط)،
        // ثم اللوحة المنشورة، ثم سجل الشراء، ثم لوحة الإدارة
        await interaction.reply({ content: `Purchase request created: **Order #${result.lastInsertRowid}**. A staff member must confirm payment before the product role is granted.`, ephemeral: true });
        await refreshOrdersPanel(interaction.guild).catch(() => {});
        const notifyKey = safeChannelId(config.channels?.orders) ? "orders" : "salesLogs";
        await sendToConfiguredChannel(interaction.guild, notifyKey, { embeds: [purchaseFeedEmbed(p, interaction.user.id, { orderId: Number(result.lastInsertRowid), note: "Awaiting staff confirmation" })] });
        await refreshAdminDashboard(interaction.guild);
        return;
      }
      if (action === "product_rate") {
        const orderId = Number(parts[0]), rating = Number(parts[1]);
        const order = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND status IN ('confirmed','delivered')").get(orderId, interaction.user.id);
        if (!order) return interaction.reply({ content: "This order is not eligible for review.", ephemeral: true });
        pendingReviews.set(`${interaction.user.id}:product:${orderId}`, { orderId, rating });
        const modal = new ModalBuilder().setCustomId(`review_modal:product:${orderId}:${rating}`).setTitle("Rate your product");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("review").setLabel("Your review (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)));
        return interaction.showModal(modal);
      }
    }

    // ─────────── تأكيد طلب من اللوحة ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_order_confirm") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      await confirmOrder(interaction, Number(interaction.values[0]));
      return;
    }

    // ─────────── تأكيد/رفض شراء منتج قبل رسالة التقييم ───────────
    if (interaction.isButton() && interaction.customId.startsWith("d7_pcheck:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const [, rawId, decision] = interaction.customId.split(":");
      const check = db.purchaseChecks.get(Number(rawId));
      if (!check) return interaction.reply({ content: "❌ This check does not exist.", ephemeral: true });
      if (check.status !== "pending") return interaction.reply({ content: `This check was already ${check.status === "approved" ? "confirmed" : "rejected"}.`, ephemeral: true });
      const approved = decision === "ok";
      // نحدّد الحالة أولاً حتى لا يمراره اثنان في نفس اللحظة
      const changed = db.purchaseChecks.decide(check.id, approved ? "approved" : "rejected", interaction.user.id);
      if (!changed.changes) return interaction.reply({ content: "Someone already decided this check.", ephemeral: true });
      // ── من هنا كل خطوة شبكة: جلب العضو، رسالة التقييم، إنشاء الطلب،
      // رسائل السجل، تحديث اللوحة، وتعديل رسالة الفحص — ديسكورد لا يمنح
      // أكثر من 3 ثوانٍ قبل ردّ. الردّ المتأخر كان ينتهي بـ10062Unknown
      // interaction ويُسقِط البوت، فنعترف أولاً ثم نكمل خلف الاعتراف.
      await interaction.deferReply({ flags: 64 }).catch(() => {});
      const product = ratings.getProducts().find(p => p.id === String(check.product_id)) || null;
      let dmSent = false;
      if (approved) {
        const target = await interaction.client.users.fetch(check.user_id).catch(() => null);
        if (target && !target.bot) dmSent = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
        // الموافقة = تصريح الموظف إن هذا شراء حقيقي، فتُسجَّل كطلب قائم بعدها
        // يُتابَع (تسليم / إلغاء) — مو تسجيل يمرّ بلا أثر ولا أثر يُدرَك.
        // الحالة تبدأ 'confirmed' مباشرة لأن التأكيد وقع الآن، ولا يُنتظر
        // تأكيد ثانٍ من لوحة الطلبات على شراء سبق ووافق عليه موظف.
        if (product) {
          const ins = db.prepare("INSERT INTO orders (guild_id,user_id,product_id,status,confirmed_at,confirmed_by) VALUES (?,?,?,'confirmed',CURRENT_TIMESTAMP,?)").run(interaction.guild.id, check.user_id, Number(product.id), interaction.user.id);
          const orderId = Number(ins.lastInsertRowid);
          await postPurchaseFeed(interaction.guild, product, check.user_id, { approvedBy: interaction.user.id, orderId });
          // رسالة حالة الطلب في رومها الخاص — نفس ما يفعله زر Buy بعد التأكيد
          const order = orderForFeed(orderId);
          if (order) await postOrderFeed(interaction.guild, order);
          // ولوحة الطلبات المنشورة تُحدَّث مع أي شراء يُعتمد
          await refreshOrdersPanel(interaction.guild).catch(() => {});
        }
      }
      // نحدّث الرسالة نفسها: نخفي الأزرار ونوضح النتيجة
      if (check.message_id && interaction.channel?.messages) {
        const msg = await interaction.channel.messages.fetch(check.message_id).catch(() => null);
        if (msg) await msg.edit(purchaseCheckPayload(check.id, check.user_id, product, approved ? "approved" : "rejected", interaction.user.id)).catch(() => {});
      }
      const lines = [
        approved
          ? `✅ Confirmed <@${check.user_id}>'s purchase of **${product?.name || "Unknown"}**.`
          : `❌ Rejected <@${check.user_id}>'s purchase — nothing was sent.`,
      ];
      if (approved && !dmSent) lines.push("⚠️ Could not DM the rating message — the member may have DMs closed.");
      return interaction.editReply({ content: lines.join("\n") }).catch(() => {});
    }

    // ─────────── تغيير حالة الطلب من الأزرار داخل رسالة الحالة ───────────
    if (interaction.isButton() && interaction.customId.startsWith("d7_order_status:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const [, rawOrder, next] = interaction.customId.split(":");
      const order = orderForFeed(Number(rawOrder));
      const act = ORDER_STATUS_ACTIONS.find(a => a.key === next);
      if (!order || !act) return interaction.reply({ content: "Order not found.", ephemeral: true });
      if (order.status === next) return interaction.reply({ content: `Order #${order.id} is already **${act.label}**.`, ephemeral: true });

      // التأكيد = تسليم الرتبة، زي ما يفعل /order-confirm — لكن المنح شبكة
      // (جلب العضو ثم إضافة الرتبة) والاعتراف بالضغط أول بأول:
      // كل ما هو محلي (preApprove + كتابة الحالة + مؤشر رسالة الحالة)
      // يجري أولاً، ثم update()، ثم الشبكة خلفه.
      if (next === "confirmed" && order.role_id) preApprove(order.user_id, order.product_id);
      setOrderStatus(order, next, interaction.user.id);

      const fresh = orderForFeed(order.id) || order;
      // الرسالة التي فيها الزر هي المرجع — نحدّث مؤشرها حتى يبقى الزر
      // والرسالة متطابقين، ولو سبق وأُنشئت رسالة أخرى صار هذا هو الجديدة
      if (interaction.message?.id) {
        fresh.status_msg_id = String(interaction.message.id);
        db.prepare("UPDATE orders SET status_msg_id=? WHERE id=?").run(fresh.status_msg_id, order.id);
      }
      // update() تعترف بالضغط وتعدّل الرسالة في مكانها — هذا هو المطلوب
      await interaction.update(statusPayload(fresh)).catch(() => {});
      // خلف الاعتراف: منح الرتبة ثم تحديث اللوحات
      if (next === "confirmed" && order.role_id) {
        const member = await interaction.guild.members.fetch(order.user_id).catch(() => null);
        if (member) await member.roles.add(order.role_id, `S2A DEV order #${order.id} confirmed`).catch(() => {});
      }
      // ولو كانت لوحة الطلبات منشورة في روم فتحديثها هي نفسها
      await refreshOrdersPanel(interaction.guild).catch(() => {});
      await refreshAdminDashboard(interaction.guild);
      return;
    }

    // ─────────── تغيير حالة الطلب من أزرار لوحة الطلبات (✏️ Edit Order) ───────────
    // مسار مستقل تماماً عن d7_order_status: زر اللوحة لا يمسّ مؤشر رسالة
    // الحالة إطلاقاً — لو مسّه لصارت رسالة اللوحة هي رسالة الحالة وضاعت
    // رسالة الحالة القديمة في الروم. هنا نغيّر الحالة فقط، ثم نزامن رسالة
    // الحالة عبر postOrderFeed (تحدّثها إن وُجدت أو تنشئها إن فقدت)، ثم
    // نعيد شاشة اللوحة بتأكيد قصير.
    if (interaction.isButton() && interaction.customId.startsWith("d7_panel_status:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const [, rawOrder, next] = interaction.customId.split(":");
      const order = orderForFeed(Number(rawOrder));
      const act = ORDER_STATUS_ACTIONS.find(a => a.key === next);
      if (!order || !act) return interaction.reply({ content: "Order not found.", ephemeral: true });
      if (order.status === next) return interaction.reply({ content: `Order #${order.id} is already **${act.label}**.`, ephemeral: true });
      // نفس منطق رسالة الحالة: تأكيد الدفع = تسليم الرتبة، والاعتراف
      // بالضغط أولًا (شبكة بعد الاعتراف لا قبله — 3 ثوانٍ فقط عند ديسكورد)
      if (next === "confirmed" && order.role_id) preApprove(order.user_id, order.product_id);
      setOrderStatus(order, next, interaction.user.id);
      const fresh = orderForFeed(order.id) || order;
      await respondWith(interaction, ordersPanelPayload(interaction, `✅ Order #${order.id} is now **${act.label}**.`)).catch(() => {});
      if (next === "confirmed" && order.role_id) {
        const member = await interaction.guild.members.fetch(order.user_id).catch(() => null);
        if (member) await member.roles.add(order.role_id, `S2A DEV order #${order.id} confirmed`).catch(() => {});
      }
      await postOrderFeed(interaction.guild, fresh);
      await refreshOrdersPanel(interaction.guild).catch(() => {});
      await refreshAdminDashboard(interaction.guild);
      return;
    }

    // ─────────── اختيار رتبة المنتج ثم السعر ثم الاسم ───────────
    if (interaction.isRoleSelectMenu() && interaction.customId === "d7_prod_role") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pending = pendingProduct.get(interaction.user.id);
      if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
      pending.roleId = interaction.values[0];
      return productAfterRole(interaction);
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_role_skip") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pending = pendingProduct.get(interaction.user.id);
      if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
      pending.roleId = "";
      return productAfterRole(interaction);
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_role_cancel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      pendingProduct.delete(interaction.user.id);
      return respondWith(interaction, { ...productsSection(), content: "❌ Product addition cancelled." });
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_name_step") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      if (!pendingProduct.has(interaction.user.id)) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
      return interaction.showModal(productNameModal());
    }

    // ─────────── حذف منتج نهائياً ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_prod_del_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const id = Number(interaction.values[0]);
      const product = db.prepare("SELECT * FROM products WHERE id=?").get(id);
      if (!product) return interaction.reply({ content: "❌ Product not found.", ephemeral: true });
      // المنتجات التي لديها طلبات مسجلة ما نحذفها — حفاظاً على سجل المبيعات
      // (وأصلاً: جدول الطلبات مرتبط بالمنتج بمفتاح خارجي)
      const orderCount = db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id=?").get(id).n;
      if (orderCount) {
        return interaction.reply({ content: `❌ Cannot delete **${product.name}** — it has ${orderCount} recorded order(s).\nDeleting it would lose the sales history. Disable it via product-edit instead.`, ephemeral: true });
      }
      // ننظف بيانات المنتج: التقييمات والمشاهدات
      db.prepare("DELETE FROM ratings WHERE product_id=?").run(String(id));
      db.prepare("DELETE FROM product_reviews WHERE product_id=?").run(id);
      db.prepare("DELETE FROM purchase_checks WHERE product_id=?").run(String(id));
      db.prepare("DELETE FROM products WHERE id=?").run(id);
      return respondWith(interaction, { ...productsSection(), content: `🗑️ Deleted product **${product.name}** permanently.` });
    }

    // ─────────── حذف طلب نهائياً ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_order_del_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const id = Number(interaction.values[0]);
      const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
      if (!order) return interaction.reply({ content: `❌ Order #${id} no longer exists.`, ephemeral: true });
      // الصف يُحذف أولاً (محلي، فوري) حتى تظهر الإحصاءات صحيحة في الرد،
      // ثم الردّ، ثم رسالة الحالة في الروم — الشبكة بعد لا قبل الرد
      db.prepare("DELETE FROM orders WHERE id=?").run(id);
      // الردّ قبل أي شبكة: تعديل اللوحة المنشورة ينتظر وراء الاعتراف
      await respondWith(interaction, ordersPanelPayload(interaction, `🗑️ Deleted order **#${id}** — its status message is being removed too.`)).catch(() => {});
      await refreshOrdersPanel(interaction.guild).catch(() => {});
      await removeOrderStatusMessage(interaction.guild, order).catch(() => {});
      return;
    }

    // ─────────── اختيار طلب لعرض بطاقته الكاملة ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_order_view_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const order = orderForFeed(Number(interaction.values[0]));
      if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
      return interaction.update(orderDetailsView(order));
    }

    // ─────────── اختيار طلب للتعديل: تعرض أزرار حالته الأربعة ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_order_edit_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const order = orderForFeed(Number(interaction.values[0]));
      if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
      return interaction.update(orderEditStatusView(order));
    }

    // ─────────── نشر/نقل لوحة الطلبات في روم ───────────
    // الرسالة تبقى في الذاكرة عبر config.ordersPanel وتتزامن مع المستودع،
    // فتبقى اللوحة حية بعد إعادة التشغيل وتتحدث مع كل تغيير في الطلبات.
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_order_publish_ch") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      // اعتراف فوري: ما بعده جلب روم ورسائل وتعديل/نشر — شبكة كلها،
      // و3 ثوانٍ فقط قبل أن يقول ديسكورد "Unknown interaction"
      await interaction.deferReply({ flags: 64 }).catch(() => {});
      const channelId = interaction.values[0];
      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch?.(channelId).catch(() => null);
      if (!channel?.isTextBased()) return interaction.editReply({ content: "That channel is not available to me." }).catch(() => {});
      const payload = ordersSection(undefined, { published: true });
      const prev = config.ordersPanel;
      // نفس الروم الذي نُشرت فيه → نحدّث الرسالة القديمة بدل تكديس نسخ
      if (prev?.messageId && prev.channelId === channelId) {
        const old = await channel.messages?.fetch?.(prev.messageId).catch(() => null);
        if (old?.edit) {
          await old.edit(payload).catch(() => {});
          return interaction.editReply(ordersPanelPayload(interaction, `✅ Orders panel updated in <#${channelId}> — it stays there and refreshes itself.`)).catch(() => {});
        }
      }
      const sent = await channel.send(payload).catch(() => null);
      if (!sent) return interaction.editReply({ content: `❌ Could not post there — check that I can send messages in <#${channelId}>.` }).catch(() => {});
      // نقل إلى روم آخر → نحذف الرسالة القديمة حتى لا تبقى لوحة ميتة
      if (prev?.messageId && prev.channelId !== channelId) {
        const oldChannel = interaction.guild.channels.cache.get(prev.channelId);
        const old = await oldChannel?.messages?.fetch?.(prev.messageId).catch(() => null);
        if (old?.delete) await old.delete().catch(() => {});
      }
      config.ordersPanel = { channelId, messageId: sent.id };
      saveConfig();
      // نعود لشاشة اللوحة بسطر تأكيد — الردّ المؤقت يترك شاشة اختيار الروم عالقة
      return interaction.editReply(ordersPanelPayload(interaction, `✅ Orders panel published in <#${channelId}> — purchase statistics, the order list and its three buttons (👁️ View Details · 🗑️ Delete · ✏️ Edit); it refreshes itself whenever an order changes.\nUse **📤 Publish panel** from /panel again to move it elsewhere.`)).catch(() => {});
    }

    // ─────────── اختيار روم نشر المنتجات ───────────
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_showcase_channel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      // اعتراف فوري قبل نشر حتى عشر رسائل — الشبكة بطيئة ولا نتجاوز 3 ثوانٍ
      await interaction.deferReply({ flags: 64 }).catch(() => {});
      const channelId = interaction.values[0];
      config.channels ||= {};
      config.channels.productShowcase = channelId;
      saveConfig();
      const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
      let sent = 0;
      for (const product of products.slice(0, 10)) {
        await interaction.guild.channels.cache.get(channelId)?.send({ embeds: [productEmbed(product)], components: productPanelRows(product.id) }).then(() => sent++).catch(() => {});
      }
      return interaction.editReply({ content: `✅ Published ${sent} product(s) in <#${channelId}>.` }).catch(() => {});
    }

    // ─────────── نظام القوانين: القائمة المنشورة واختيار القسم ───────────
    // رسالة واحدة منشورة فيها قائمة الأقسام — ضغط أي قسم يرد برسالة خاصة
    // بقوانينه مرقّمة عربي ثم إنجليزي، بلا صلاحية مطلوبة (القوانين عامة).
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_rules_section") {
      const sec = ensureRules().sections.find(s => s.id === interaction.values[0]);
      if (!sec) return interaction.reply({ content: "❌ This section no longer exists.", ephemeral: true });
      return interaction.reply({ embeds: [rulesCardEmbed(sec)], ephemeral: true });
    }

    // قوائم الأقسام الثلاث داخل /panel: عرض قسم، اختيار قسم للتعديل،
    // وانتخاب قسم للحذف (يفتح شاشة التأكيد) — كلها staff فقط
    if (interaction.isStringSelectMenu() && ["d7_rulebook_sel", "d7_rulebook_edit_sel", "d7_rulebook_del_sel"].includes(interaction.customId)) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const sec = ensureRules().sections.find(s => s.id === interaction.values[0]);
      if (!sec) return interaction.reply({ content: "❌ That section no longer exists.", ephemeral: true });
      if (interaction.customId === "d7_rulebook_edit_sel") return interaction.showModal(rulesSectionModal(sec));
      if (interaction.customId === "d7_rulebook_del_sel") return interaction.update(rulesDeleteConfirm(sec));
      return interaction.update(rulesSectionView(sec));
    }

    // اختيار روم لنشر رسالة القوانين
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_rules_publish_ch") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      // اعتراف فوري: ما بعده جلب روم ورسالة ونشر أو نقل — شبكة كلها
      await interaction.deferReply({ flags: 64 }).catch(() => {});
      const channelId = interaction.values[0];
      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch?.(channelId).catch(() => null);
      if (!channel?.isTextBased()) return interaction.editReply({ content: "That channel is not available to me." }).catch(() => {});
      const book = ensureRules();
      const payload = rulesPublicPayload();
      // نفس الروم الذي نُشرت فيه → نُعيد كتابتها في مكانها لا نكدّس نسخاً
      if (book.messageId && book.channelId === channelId) {
        const old = await channel.messages?.fetch?.(book.messageId).catch(() => null);
        if (old?.edit) {
          await old.edit(payload).catch(() => {});
          return interaction.editReply(rulesSection(`✅ Rules message updated in <#${channelId}>.`)).catch(() => {});
        }
      }
      const sent = await channel.send(payload).catch(() => null);
      if (!sent) return interaction.editReply({ content: `❌ Could not post there — check that I can send messages in <#${channelId}>.` }).catch(() => {});
      // نقل إلى روم آخر → نحذف الرسالة القديمة حتى لا تبقى قوانين مكرّرة
      if (book.messageId && book.channelId !== channelId) {
        const oldChannel = interaction.guild.channels.cache.get(book.channelId);
        const old = await oldChannel?.messages?.fetch?.(book.messageId).catch(() => null);
        if (old?.delete) await old.delete().catch(() => {});
      }
      book.channelId = channelId;
      book.messageId = String(sent.id);
      saveConfig();
      return interaction.editReply(rulesSection(`✅ Rules published in <#${channelId}> — members pick a section from its menu.`)).catch(() => {});
    }

    // ─────────── نماذج القوانين: قسم جديد أو محرَّر، وعنوان الرسالة ───────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith("rules_sec:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const key = interaction.customId.split(":")[1];
      const { name, rules } = rulesFromFields(interaction);
      if (!name) return interaction.reply({ content: "❌ The section name is required.", ephemeral: true });
      if (!rules.length) return interaction.reply({ content: "❌ Write at least one rule — one per line.", ephemeral: true });
      const book = ensureRules();
      let sec;
      if (key === "new") {
        if (book.sections.length >= 25) return interaction.reply({ content: "❌ Discord allows 25 sections in one menu.", ephemeral: true });
        sec = { id: `s${Date.now().toString(36)}`, name, rules };
        book.sections.push(sec);
      } else {
        sec = book.sections.find(s => s.id === key);
        if (!sec) return interaction.reply({ content: "❌ That section no longer exists.", ephemeral: true });
        sec.name = name;
        sec.rules = rules;
      }
      saveConfig();
      // الردّ أولًا (اعتراف بالضغط) ثم تحديث الرسالة المنشورة خلفه
      await respondWith(interaction, rulesSectionView(sec)).catch(() => {});
      await refreshRulesMessage(interaction.guild).catch(() => {});
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "rules_settings") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const book = ensureRules();
      book.title = String(interaction.fields.getTextInputValue("title") || "").trim().slice(0, 256) || book.title;
      book.introAr = String(interaction.fields.getTextInputValue("ar") || "").trim();
      book.introEn = String(interaction.fields.getTextInputValue("en") || "").trim();
      const img = String(interaction.fields.getTextInputValue("image") || "").trim();
      book.image = /^https?:\/\//i.test(img) ? img : "";
      saveConfig();
      await respondWith(interaction, rulesSection("✅ Title, intro and banner saved.")).catch(() => {});
      await refreshRulesMessage(interaction.guild).catch(() => {});
      return;
    }

    // ─────────── اختيار رومات التنبيهات والنشر ───────────
    // كل قائمة اختيار روم معرفة هنا بالكامل: المفتاح في config + القسم اللي
    // يتعاد رسمه بعد الحفظ. أي قائمة جديدة تُضاف هنا فقط ولا تنكسر بعدين.
    const channelPickers = {
      "d7_ch_orders":     { key: "orders",           section: channelsSection },
      "d7_ch_sales":      { key: "salesLogs",        section: channelsSection },
      "d7_ch_showcase":   { key: "productShowcase",  section: channelsSection },
      // "d7_ch_reviews" محفوظ للتوافق مع لوحات منشورة سابقاً —
      // القائمة نفسها شلناها من قسم الرومات (صارت في قسم التقييمات فقط).
      "d7_ch_reviews":    { key: "reviews",          section: channelsSection },
      "d7_welcome_ch":    { key: "welcome",          section: channelsSection },
      "d7_order_ch":      { key: "orders",           section: () => ordersPanelPayload(interaction) },
      "d7_order_status_ch": { key: "orderStatus",    section: () => ordersPanelPayload(interaction) },
      "d7_prod_status_ch": { key: "productStatus",   section: () => ordersPanelPayload(interaction) },
      "d7_ratings_ch":    { key: "reviews",          section: ratingsSection },
      "d7_pcheck_ch":     { key: "purchaseChecks",   section: ratingsSection },
    };
    if (interaction.isChannelSelectMenu() && channelPickers[interaction.customId]) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pick = channelPickers[interaction.customId];
      config.channels ||= {};
      config.channels[pick.key] = interaction.values[0];
      saveConfig();
      // نعيد رسم نفس القسم أولًا (اعتراف بالضغط قبل أي شبكة)، ثم
      // تحديث اللوحة المنشورة إن كانت هذه القسمة مخصّصة لها
      await interaction.update(pick.section()).catch(() => {});
      await refreshOrdersPanel(interaction.guild).catch(() => {});
      return;
    }

    // ─────────── لوحة التذاكر: فتح تذكرة ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_ticket_type") {
      return tickets.handleSelect(interaction);
    }

    // ─────────── قسم الترحيب: الرومات والرتبة ───────────
    const welcomeChMap = {
      "d7_welcome_store": "storeChannelId",
      "d7_welcome_help": "helpChannelId",
      "d7_welcome_releases": "releasesChannelId",
    };
    if (interaction.isChannelSelectMenu() && welcomeChMap[interaction.customId]) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      ensureWelcome();
      // min 0 → الإرسال بدون قيمة يعني مسح الرابط (تختفي من رسالة الترحيب)
      config.welcome[welcomeChMap[interaction.customId]] = interaction.values[0] || "";
      saveConfig();
      return interaction.update(welcomeSection(interaction.values[0] ? "✅ Channel saved." : "🗑️ Link cleared — this line no longer appears in the welcome message."));
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === "d7_welcome_role") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      ensureWelcome();
      config.welcome.storeRoleId = interaction.values[0] || "";
      saveConfig();
      return interaction.update(welcomeSection(interaction.values[0] ? "✅ Store role saved." : "🗑️ Role cleared — the store line no longer appears in the welcome message."));
    }

    // ─────────── زر التجربة: إرسال رسالة الترحيب لعضو مختار ───────────
    // يرسل بالوضع الفعلي نفسه (خاص نصي أو روم بإيمبد ومنشن) وبلا أي أثر
    // على الإرسال التلقائي — التجربة تجربة فقط، وزر التشغيل يبقى كلامه.
    if (interaction.isUserSelectMenu() && interaction.customId === "d7_welcome_test_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const targetId = interaction.values[0] || "";
      if (!safeChannelId(targetId)) return interaction.update(welcomeTestView());
      ensureWelcome();
      // اعتراف فوري: ما بعده جلب العضو وإرسال خاص أو نشر في الروم — شبكة،
      // و3 ثوانٍ فقط قبل أن يقول ديسكورد "didn't respond in time"
      await interaction.deferUpdate().catch(() => {});
      if (config.welcome.sendDM !== false) {
        const user = await interaction.client.users.fetch(targetId).catch(() => null);
        const sent = user
          ? await user.send(welcomeDMPayload()).then(() => true).catch(() => false)
          : false;
        return interaction.editReply(welcomeSection(sent
          ? `🧪 Test welcome sent to <@${targetId}> — plain text DM, exactly like a new member's.`
          : `❌ Could not DM <@${targetId}> — their DMs are closed. Switch the mode to the welcome channel to test there.`));
      }
      const channel = channelFromConfig(interaction.guild, "welcome");
      if (!channel?.isTextBased()) return interaction.editReply(welcomeSection("⚠️ Set the welcome channel first — **Channels** section → 👋 Welcome channel."));
      const posted = await channel.send({ ...welcomePayload(), content: `<@${targetId}>` }).catch(() => null);
      return interaction.editReply(welcomeSection(posted
        ? `🧪 Test welcome posted in <#${channel.id}> for <@${targetId}> — exactly like a new member's.`
        : "❌ Could not post the test welcome — check that I can send messages in the welcome channel."));
    }

    // ─────────── نظام التقييمات (نسخة من NSR Hub) ───────────
    if (interaction.isButton() && interaction.customId.startsWith("rate_lang_")) return ratings.handleLangButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("rate_star_")) return ratings.handleStarButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("rate_comment_")) {
      // التقييم يُكتب في orders.rating داخل الدالة — وبعدها نُعيد رسم رسالة
      // حالة الطلب واللوحة المنشورة، وإلا يبقى "لم يتم التقييم" و"no rating"
      // ظاهرين رغم أن التقييم وصل قاعدة البيانات (شكوى صاحب البوت حرفياً).
      const ratedOrderId = await ratings.handleCommentModal(interaction);
      // النافذة قد تأتي من خاص العميل (لا guild هناك) → نأخذ الخادم من الوصلة
      const rateGuildId = interaction.customId.split("_")[2];
      const rateGuild = interaction.guild || interaction.client?.guilds?.cache?.get(rateGuildId);
      await repaintAfterRating(rateGuild, ratedOrderId);
      return;
    }
    if (interaction.isButton() && interaction.customId === "d7_rate_send") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const modal = new ModalBuilder().setCustomId("d7_rate_send_modal").setTitle("Send a rating to a customer");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Member ID (User ID)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("product").setLabel("Product name or number").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      );
      return interaction.showModal(modal);
    }

    // ─────────── الصلاحيات ───────────
    if (interaction.isButton() && interaction.customId === "d7_perm_admins") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const ids = (config.permissions?.adminUserIds || []).join(", ");
      const modal = new ModalBuilder().setCustomId("d7_perm_admins_modal").setTitle("Bot managers");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ids").setLabel("Manager IDs (comma separated)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder(ids || "123456789012345678").setMaxLength(1000)
      ));
      return interaction.showModal(modal);
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === "d7_perm_staff") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      config.roles ||= {};
      config.roles.staff = interaction.values;
      saveConfig();
      return interaction.update(permsSection());
    }

    // ─────────── أزرار التذاكر داخل الروم ───────────
    if (interaction.isButton() && (interaction.customId === "d7_tk_claim" || interaction.customId === "d7_tk_summon" || interaction.customId === "d7_tk_close")) {
      if (interaction.customId === "d7_tk_claim") return tickets.handleClaim(interaction);
      if (interaction.customId === "d7_tk_summon") return tickets.handleSummon(interaction);
      return tickets.handleClose(interaction);
    }

    // ─────────── إعدادات التذاكر من اللوحة ───────────
    if (interaction.isButton() && interaction.customId.startsWith("d7_tk_btn:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const typeId = interaction.customId.split(":")[1];
      const tp = tickets.types().find(x => x.id === typeId);
      if (!tp) return interaction.reply({ content: "❌ That type does not exist.", ephemeral: true });
      tp.enabled = tp.enabled === false;
      tickets.saveConfig();
      await interaction.update(ticketsSection());
      return interaction.followUp({ content: `${tp.enabled === false ? "❌ Hid" : "✅ Shown"} the **${tp.label}** type.\nRe-send the ticket panel to apply.`, ephemeral: true }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_add") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const modal = new ModalBuilder().setCustomId("d7_tk_add_modal").setTitle("➕ Add a ticket type");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_name").setLabel("Type name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setPlaceholder("e.g. Purchase")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_desc").setLabel("Description").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder("e.g. Ask about buying a product or service")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_emoji").setLabel("Emoji (single)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder("e.g. 🛒")),
      );
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_del") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const custom = tickets.types().filter(x => String(x.id || "").startsWith("c"));
      if (!custom.length) {
        return interaction.reply({ content: "🗑️ No custom types to delete — the built-in types cannot be removed.", ephemeral: true });
      }
      await interaction.update({ embeds: [interaction.message.embeds[0]], components: ticketDeleteRows() });
      return interaction.followUp({ content: "🗑️ Pick the custom type to delete from the menu below.", ephemeral: true }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_del_back") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      return interaction.update(ticketsSection());
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_tk_del_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const typeId = interaction.values[0];
      const all = tickets.types();
      const tp = all.find(x => x.id === typeId);
      if (!tp || !String(tp.id || "").startsWith("c")) {
        await interaction.update(ticketsSection());
        return interaction.followUp({ content: "❌ This type is built-in and cannot be deleted.", ephemeral: true }).catch(() => {});
      }
      tickets.ensureConfig().ticketTypes = all.filter(x => x.id !== typeId);
      tickets.saveConfig();
      await interaction.update(ticketsSection());
      return interaction.followUp({ content: `🗑️ Deleted the **${tp.label}** type. Re-send the panel to apply.`, ephemeral: true }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_text") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const t = tickets.ensureConfig();
      const modal = new ModalBuilder().setCustomId("d7_tk_text_modal").setTitle("Ticket panel text");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_title").setLabel("Panel title").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder((t.panel?.title || "🎫 Support Tickets").slice(0, 100)).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_body").setLabel("Panel description").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("Welcome to our support system! ...").setMaxLength(900)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_footer").setLabel("Footer (optional)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder((t.panel?.footer || config.brand?.footer || "S2A DEV").slice(0, 100)).setMaxLength(100)),
      );
      return interaction.showModal(modal);
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_tk_category") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      tickets.ensureConfig().categoryId = interaction.values[0];
      tickets.saveConfig();
      return interaction.update(ticketsSection());
    }
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_tk_log") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      tickets.ensureConfig().logChannelId = interaction.values[0];
      tickets.saveConfig();
      return interaction.update(ticketsSection());
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === "d7_tk_staff") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      tickets.ensureConfig().staffRoles = interaction.values;
      tickets.saveConfig();
      return interaction.update(ticketsSection());
    }

    if (interaction.isModalSubmit() && interaction.customId === "d7_tk_add_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const name = interaction.fields.getTextInputValue("tk_name").trim();
      const desc = interaction.fields.getTextInputValue("tk_desc").trim();
      const emoji = interaction.fields.getTextInputValue("tk_emoji").trim();
      if (!name || !desc) return interaction.reply({ content: "❌ The type name and description are required.", ephemeral: true });
      const t = tickets.ensureConfig();
      const tp = { id: "c" + Date.now().toString(36), label: name, description: desc, color: EMBED_COLOR, enabled: true };
      if (emoji && /^\p{Extended_Pictographic}$/u.test(emoji)) tp.emoji = emoji;
      else if (emoji) tp.emoji = "";
      t.ticketTypes.push(tp);
      tickets.saveConfig();
      await interaction.reply({ content: `✅ Added the **${name}** type. Re-send the panel to apply.`, ephemeral: true });
      return interaction.message?.edit(ticketsSection()).catch(() => {});
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_tk_text_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const t = tickets.ensureConfig();
      t.panel ||= {};
      t.panel.title = interaction.fields.getTextInputValue("tk_title").trim();
      t.panel.description = interaction.fields.getTextInputValue("tk_body").trim();
      t.panel.footer = (interaction.fields.getTextInputValue("tk_footer") || "").trim() || config.brand?.footer || "S2A DEV";
      tickets.saveConfig();
      await interaction.reply({ content: "✅ Ticket panel text saved.", ephemeral: true });
      return interaction.message?.edit(ticketsSection()).catch(() => {});
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_rate_send_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const userId = interaction.fields.getTextInputValue("user").trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content: "❌ Invalid member ID.", ephemeral: true });
      const raw = interaction.fields.getTextInputValue("product").trim();
      const product = ratings.findProduct(interaction.guildId, raw);
      if (!product) return interaction.reply({ content: "❌ Product not found. Available products:\n" + ratings.getProducts().map(p => `• **${p.name}**`).join("\n"), ephemeral: true });
      const target = await interaction.client.users.fetch(userId).catch(() => null);
      if (!target || target.bot) return interaction.reply({ content: "❌ No real member was found.", ephemeral: true });
      const ok = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
      if (!ok) return interaction.reply({ content: `❌ Could not DM ${target} — their DMs may be closed.`, ephemeral: true });
      return interaction.reply({ content: `✅ Sent the **${product.name}** rating DM to ${target}.`, ephemeral: true });
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_perm_admins_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const ids = (interaction.fields.getTextInputValue("ids") || "").split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));
      config.permissions ||= {};
      config.permissions.adminUserIds = ids;
      saveConfig();
      await interaction.reply({ content: `✅ Saved ${ids.length} bot manager(s).`, ephemeral: true });
      return interaction.message?.edit(permsSection()).catch(() => {});
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("panel_modal:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const kind = interaction.customId.split(":")[1];
      if (kind === "add-price") {
        const price = Number(interaction.fields.getTextInputValue("price").replace(/,/g, ""));
        if (!Number.isFinite(price) || price < 0) return interaction.reply({ content: "The price must be a number, e.g. 150 or 150.50", ephemeral: true });
        const pending = pendingProduct.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
        pending.price = price;
        if (pending.name === null || pending.name === undefined) return respondWith(interaction, productNameStep());
        return finishProduct(interaction);
      }
      if (kind === "add-name") {
        const pending = pendingProduct.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: "The product step timed out. Run /product-add again.", ephemeral: true });
        pending.name = interaction.fields.getTextInputValue("name").trim();
        return finishProduct(interaction);
      }
      if (kind === "welcome_text") {
        ensureWelcome();
        config.welcome.title = interaction.fields.getTextInputValue("title").trim() || "Welcome!";
        config.welcome.message = interaction.fields.getTextInputValue("body").trim();
        config.welcome.footer = interaction.fields.getTextInputValue("footer").trim();
        // رابط فارغ أو غير صالح يُبقي الصورة الحالية — لا يمسحها صمتاً
        // (سلوك نافذة الصورة القديمة نفسها)
        const url = interaction.fields.getTextInputValue("url").trim();
        if (/^https?:\/\//.test(url)) config.welcome.imageUrl = url;
        saveConfig();
        await interaction.reply({ content: "✅ Welcome message text saved.", ephemeral: true });
        return interaction.message?.edit(welcomeSection("✅ Text saved.")).catch(() => {});
      }
      if (kind === "welcome_image") {
        ensureWelcome();
        const url = interaction.fields.getTextInputValue("url").trim();
        if (url && !/^https?:\/\//.test(url)) {
          return interaction.reply({ content: "❌ The URL must start with `https://` or `http://`.", ephemeral: true });
        }
        config.welcome.imageUrl = url;
        saveConfig();
        await interaction.reply({ content: url ? "✅ Welcome image saved." : "✅ Welcome image cleared.", ephemeral: true });
        return interaction.message?.edit(welcomeSection(url ? "✅ Image saved." : "✅ Image cleared.")).catch(() => {});
      }
      if (kind === "intro_edit") {
        const intro = ensureIntro();
        const url = interaction.fields.getTextInputValue("image").trim();
        if (url && !/^https?:\/\//.test(url)) {
          return interaction.reply({ content: "? The URL must start with `https://` or `http://`.", ephemeral: true });
        }
        intro.title = interaction.fields.getTextInputValue("title").trim().slice(0, 256) || intro.title;
        intro.text = interaction.fields.getTextInputValue("text").trim();
        intro.image = /^https?:\/\//.test(url) ? url : "";
        saveConfig();
        // الاعتراف بالضغط أولًا، ثم تعديل رسالة اللوحة، ثم إعادة رسم
        // الرسالة المثبّتة في الروم إن كانت قد نُشرت من قبل
        await interaction.reply({ content: "? The pinned welcome message was updated.", ephemeral: true }).catch(() => {});
        await interaction.message?.edit(welcomeSection("? Intro updated.")).catch(() => {});
        await refreshIntroMessage(interaction.guild).catch(() => {});
        return;
      }
      const title = interaction.fields.getTextInputValue("title");
      const body = interaction.fields.getTextInputValue("body");
      const image = (interaction.fields.getTextInputValue("image") || "").trim();
      const e = embed(title, body);
      if (image) { if (!/^https?:\/\//i.test(image)) return interaction.reply({ content: "Image URL must start with http:// or https://.", ephemeral: true }); e.setImage(image); }
      if (kind === "embed") {
        const channelId = interaction.fields.getTextInputValue("channel").trim();
        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel?.isTextBased()) return interaction.reply({ content: "Channel ID is invalid or not a text channel.", ephemeral: true });
        await channel.send({ embeds: [e] });
        return interaction.reply({ content: `Embed sent to ${channel}.`, ephemeral: true });
      }
      const channelKey = ({news:"news",rules:"rules",update:"updates"})[kind];
      const channel = channelFromConfig(interaction.guild, channelKey);
      if (!channel?.isTextBased()) return interaction.reply({ content: `Configure the ${channelKey} channel ID in config.json first.`, ephemeral: true });
      await channel.send({ embeds: [e] });
      return interaction.reply({ content: `${kind} posted in ${channel}.`, ephemeral: true });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("review_modal:")) {
      const [, type, idStr, ratingStr] = interaction.customId.split(":");
      const id = Number(idStr), rating = Number(ratingStr);
      const review = interaction.fields.getTextInputValue("review") || "";
      if (type === "product") {
        const order = db.prepare("SELECT o.*,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.user_id=?").get(id, interaction.user.id);
        if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
        // اعتراف فوري قبل الكتابات ورسائل السجل واللوحات (شبكة كلها)
        await interaction.deferReply({ flags: 64 }).catch(() => {});
        db.prepare("UPDATE orders SET rating=?,review=? WHERE id=?").run(rating, review, id);
        db.prepare("INSERT OR REPLACE INTO product_reviews (order_id,user_id,product_id,rating,review) VALUES (?,?,?,?,?)").run(id, interaction.user.id, order.product_id, rating, review);
        await sendToConfiguredChannel(interaction.guild, "reviews", { embeds: [embed("Product review", `Product: **${order.product_name}**\nCustomer: <@${interaction.user.id}>\nRating: ${rating}/5\nReview: ${review || "No written comment."}`)] });
        // التقييم وصل الطلب — أعد رسم رسالة الحالة (تقرأ rating وقت الرسم)
        // واللوحة المنشورة، وإلا بقي "لم يتم التقييم" و"no rating" كما هما
        await repaintAfterRating(interaction.guild, id);
        return interaction.editReply({ content: "Thank you! Your product review has been saved." }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const message = { content: "Something went wrong. Check the bot console and config.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(message).catch(() => {});
    else await interaction.reply(message).catch(() => {});
  }
}

// الالتقاط الأخير: `return interaction.reply(...)` يعيد وعداً خارج نطاق
// الـtry (رفضه لا يمرّ بـcatch الداخلي)، وكان هذا بالضبط ما يُسقِط البوت —
// 10062 Unknown interaction يرفض، الوعود تفلت، العملية تموت، وبعدها كل
// ضغطة تنتهي بـ "didn't respond in time". الآن يُسجَّل ولا يُسقط.
client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction).catch((err) => {
  console.error("Interaction error:", err);
  if (err && err.code === 10062) return; // التفاعل انتهت صلاحيته — الرد متأخر لا ينفع
  const message = { content: "Something went wrong. Check the bot console and config.", ephemeral: true };
  if (interaction.deferred || interaction.replied) interaction.followUp(message).catch(() => {});
  else interaction.reply(message).catch(() => {});
}));

client.login(process.env.DISCORD_TOKEN);
