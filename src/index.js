require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder
} = require("discord.js");
const db = require("./db");
const { embed, hasStaff, formatPrice, safeChannelId, cleanFileName } = require("./utils");
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
    new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Dashboard").setEmoji("🔄").setStyle(ButtonStyle.Success)
  );
  const e = embed("D7 Dev • Control Center", [
    "🛍️ **Products** — إضافة منتج والنشر في الرومات",
    "🧾 **Orders** — الطلبات وتأكيد الدفع وروم إرسالها",
    "🎫 **Tickets** — أنواع التذاكر ولوحة الإرسال",
    "📌 **Channels** — رومات التنبيهات والنشر",
    "📝 **Messages** — أخبار وقوانين وإمبدات",
    "⭐ **Ratings** — نظام التقييمات وروم التقييمات",
    "📊 **Analytics** — المبيعات والتقييمات",
    "🛒 **Store Settings** — إعدادات الشراء والخاص",
    "👋 **Welcome** — رسالة الترحيب",
    "🏷️ **Auto Roles** — الرتب التلقائية",
    "🔐 **Permissions** — مدراء البوت ورتب الإدارة",
    "📈 **Ticket Stats** — إحصائيات التذاكر",
  ].join("\n"));
  return { embeds: [e], components: [row1, row2, row3] };
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
      new ButtonBuilder().setCustomId("panel:delete-product").setLabel("🗑️ حذف منتج").setStyle(ButtonStyle.Danger)
    )],
    content: message || undefined,
  };
}

// قائمة اختيار المنتج المراد حذفه (تظهر بعد ضغط زر الحذف)
function productDeleteRows() {
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 25").all();
  if (!products.length) return null;
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId("d7_prod_del_sel").setPlaceholder("اختر المنتج الذي تريد حذفه نهائياً...").setMinValues(1).setMaxValues(1)
    .addOptions(products.map(p => new StringSelectMenuOptionBuilder()
      .setLabel(`#${p.id} — ${p.name}`.slice(0, 100))
      .setDescription(`${formatPrice(p.price, p.currency)} — حذف نهائي`.slice(0, 100))
      .setValue(String(p.id)))))];
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
  return safeChannelId(id) ? `<#${id}>` : "غير محدد";
}

function channelsSection() {
  const rows = [
    new ActionRowBuilder().addComponents(channelRow("d7_ch_orders", "orders", `🔔 روم تنبيه الطلبات — الحالي: ${chLabel("orders")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ch_sales", "salesLogs", `🛒 روم طلبات الشراء — الحالي: ${chLabel("salesLogs")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ch_showcase", "productShowcase", `🛍️ روم عرض المنتجات — الحالي: ${chLabel("productShowcase")}`)),
    // ⚠️ روم التقييمات ما عاد هنا — صار في قسم التقييمات فقط حتى ما يتكرر
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 القائمة الرئيسية").setStyle(ButtonStyle.Secondary)),
  ];
  return { embeds: [embed("📌 الرومات", "اختر الروم المناسب من كل قائمة — يُحفظ فوراً.\nروم التقييمات تُحدَّد من قسم **⭐ Ratings**.")], components: rows };
}

// ─────────── قسم التذاكر (مطابق لصورة لوحة تحكم NSR) ───────────
function ticketsSection() {
  const t = tickets.ensureConfig();
  const all = tickets.types();
  const on = all.filter(x => x.enabled !== false);
  const lines = all.length
    ? all.map(tp => `${tp.enabled === false ? "❌" : "✅"} ${tp.emoji || ""} **${tp.label}** — ${tp.description}${String(tp.id || "").startsWith("c") ? " *(مخصص)*" : ""}`).join("\n")
    : "لا توجد أنواع بعد. اضغط **➕ اضافة نوع** بالأسفل.";

  const e = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("🎫 نظام التذاكر")
    .setDescription([
      `**عنوان اللوحة:** ${t.panel?.title || "🎫 Support Tickets"}`,
      `**الحالة:** ${on.length} نوع مفعّل من ${all.length || 0}`,
      "",
      "**الأنواع:**",
      lines,
      "",
      `**الكاتيجوري:** ${safeChannelId(t.categoryId) ? `<#${t.categoryId}>` : "غير محدد"}`,
      `**روم اللوق:** ${safeChannelId(t.logChannelId) ? `<#${t.logChannelId}>` : "غير محدد"}`,
      `**رتب الدعم:** ${(t.staffRoles || []).length ? t.staffRoles.map(r => `<@&${r}>`).join(" ") : "غير محددة"}`,
    ].join("\n"))
    .setFooter({ text: config.brand?.footer || "D7 Dev" })
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
    new ButtonBuilder().setCustomId("d7_tk_add").setLabel("➕ اضافة نوع").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("d7_tk_del").setLabel("🗑️ حذف نوع").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel:publish-tickets").setLabel("⬆️ ارسال رسالة التذاكر").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("d7_tk_text").setLabel("✏️ نص اللوحة").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 رجوع للرئيسية").setStyle(ButtonStyle.Secondary),
  ));

  const category = new ChannelSelectMenuBuilder().setCustomId("d7_tk_category")
    .setPlaceholder(`📁 الكاتيجوري — الحالي: ${safeChannelId(t.categoryId) ? `<#${t.categoryId}>` : "غير محدد"}`)
    .addChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
  if (safeChannelId(t.categoryId)) category.setDefaultChannels([t.categoryId]);
  const log = new ChannelSelectMenuBuilder().setCustomId("d7_tk_log")
    .setPlaceholder(`📋 روم اللوق — الحالي: ${safeChannelId(t.logChannelId) ? `<#${t.logChannelId}>` : "غير محدد"}`)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1);
  if (safeChannelId(t.logChannelId)) log.setDefaultChannels([t.logChannelId]);
  const staff = new RoleSelectMenuBuilder().setCustomId("d7_tk_staff")
    .setPlaceholder(`👮 رتب الدعم — الحالي: ${(t.staffRoles || []).length} رتبة`)
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
      .setPlaceholder("اختر النوع المخصص الذي تريد حذفه...")
      .addOptions(custom.map(tp => {
        const opt = new StringSelectMenuOptionBuilder().setLabel(tp.label).setDescription(tp.description).setValue(tp.id);
        if (tp.emoji && /^\p{Extended_Pictographic}$/u.test(tp.emoji.trim())) opt.setEmoji(tp.emoji.trim());
        return opt;
      }))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("d7_tk_del_back").setLabel("🔙 رجوع").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// ─────────── قسم الطلبات (مع اختيار روم إرسال الطلبات) ───────────
function ordersSection() {
  const rowsData = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
  const desc = rowsData.length
    ? rowsData.map(o => `**#${o.id}** · ${o.product_name} · <@${o.user_id}> · **${o.status}** · ${formatPrice(o.price,o.currency)}\n⭐ ${o.rating ? `${o.rating}/5` : "بدون تقييم"}`).join("\n")
    : "No orders yet.";
  const pending = db.prepare(`SELECT o.id,o.user_id,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.status='pending' ORDER BY o.id DESC LIMIT 20`).all();
  const rows = [];
  if (pending.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("d7_order_confirm").setPlaceholder("✅ اختر طلب لتأكيد الدفع وإعطائه الرتبة").setMinValues(1).setMaxValues(1)
      .addOptions(pending.map(o => new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} — ${o.product_name}`.slice(0, 100))
        .setDescription(`${o.user_id} • ${formatPrice(o.price,o.currency)}`.slice(0, 100))
        .setValue(String(o.id))))));
  }
  // ⬇️ الروم اللي تُرسل فيه الطلبات
  rows.push(new ActionRowBuilder().addComponents(channelRow("d7_order_ch", "orders", `🔔 روم إرسال الطلبات — الحالي: ${chLabel("orders")}`)));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:orders").setLabel("🔄 تحديث").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary)
  ));
  return { embeds: [embed("🧾 الطلبات", `${desc}\n\nأكّد الدفع من القائمة بالأعلى، والعميل ياخذ رتبة المنتج تلقائياً.\nروم إرسال الطلبات يُحدَّد من القائمة بالأسفل.`)], components: rows.slice(0, 5) };
}

// ─────────── قسم التقييمات (نسخة من NSR Hub) ───────────
function ratingsSection() {
  const products = db.prepare("SELECT id,name,price,currency FROM products ORDER BY id DESC").all();
  const list = products.length
    ? products.map(p => {
        const r = db.ratings.byProduct(p.id);
        return `**#${p.id} — ${p.name}** — ${r.n ? `${Number(r.avg).toFixed(1)}/5 (${r.n} تقييم)` : "بدون تقييم"}`;
      }).join("\n")
    : "No products yet.";
  const rows = [
    new ActionRowBuilder().addComponents(channelRow("d7_pcheck_ch", "purchaseChecks", `🛒 روم تأكيد الشراء — الحالي: ${chLabel("purchaseChecks")}`)),
    new ActionRowBuilder().addComponents(channelRow("d7_ratings_ch", "reviews", `⭐ روم التقييمات — الحالي: ${chLabel("reviews")}`)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_rate_send").setLabel("⭐ إرسال تقييم لعميل").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:ratings").setLabel("🔄 تحديث").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("⭐ نظام التقييمات", [
    `${list}`,
    "",
    `**روم تأكيد الشراء:** ${safeChannelId(config.channels?.purchaseChecks) ? `<#${config.channels.purchaseChecks}>` : "غير محدد — تُرسل رسالة التقييم مباشرة بدون تأكيد."}`,
    "أي عضو ياخذ رتبة منتج يجيه طلب تأكيد في الروم المحدد: تأكيد يرسل التقييم، ورفض ما يوصله شي.",
    "",
    `**روم التقييمات:** ${chLabel("reviews")} — التقييمات تُنشر فيه.`,
  ].join("\n"))], components: rows };
}

// ─────────── قسم إعدادات المتجر ───────────
function storeSection() {
  const p = config.purchase ||= {};
  const btn = (id, label, on) => new ButtonBuilder().setCustomId(id).setLabel(`${on ? "✅" : "❌"} ${label}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  const rows = [
    new ActionRowBuilder().addComponents(
      btn("panel:store:manual", "تأكيد الدفع يدوياً", p.manualConfirmation !== false),
      btn("panel:store:thankyou", "رسالة شكر خاصة", p.sendThankYouDM === true),
      btn("panel:store:reviewdm", "رسالة تقييم خاصة", p.sendProductReviewDM === true),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🛒 إعدادات المتجر", [
    `**تأكيد الدفع اليدوي:** ${p.manualConfirmation !== false ? "✅ مفعّل" : "❌ معطّل"} — الطلبات تحتاج موافقة موظف قبل إعطاء الرتبة.`,
    `**رسالة الشكر:** ${p.sendThankYouDM === true ? "✅ مفعّل" : "❌ معطّل"} — رسالة خاصة بعد تأكيد الطلب.`,
    `**رسالة التقييم:** ${p.sendProductReviewDM === true ? "✅ مفعّل" : "❌ معطّل"} — تصل تلقائياً للعضو بأي رتبة منتج ياخذها.`,
    "",
    "اضغط على الزر لتبديل الحالة.",
  ].join("\n"))], components: rows };
}

// ─────────── قسم الصلاحيات ───────────
function permsSection() {
  const admins = (config.permissions?.adminUserIds || []).filter(Boolean);
  const staffRoles = (config.roles?.staff || []).filter(Boolean);
  const adminRole = config.roles?.admin || [];
  const roleSelect = new RoleSelectMenuBuilder().setCustomId("d7_perm_staff")
    .setPlaceholder(`👮 رتب الإدارة/الموظفين — الحالي: ${staffRoles.length} رتبة`)
    .setMinValues(0).setMaxValues(10);
  if (staffRoles.length) roleSelect.setDefaultRoles(staffRoles);
  const rows = [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_perm_admins").setLabel("🔑 مدراء البوت").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🔐 الصلاحيات", [
    `**مدراء البوت:** ${admins.length ? admins.map(id => `<@${id}>`).join(" ") : "غير محددين"}`,
    `**رتب الإدارة:** ${adminRole.length ? adminRole.map(id => `<@&${id}>`).join(" ") : "غير محددة"}`,
    `**رتب الموظفين:** ${staffRoles.length ? staffRoles.map(id => `<@&${id}>`).join(" ") : "غير محددة"}`,
    "",
    "من يستطيع استخدام أوامر اللوحة.",
  ].join("\n"))], components: rows };
}

// ─────────── إحصائيات التذاكر ───────────
function ticketStatsSection() {
  const s = db.tickets.stats(null);
  const rows = db.prepare(`SELECT type, COUNT(*) c FROM tickets GROUP BY type ORDER BY c DESC`).all();
  const byType = rows.length ? rows.map(r => `**${r.type}** — ${r.c}`).join("\n") : "لا توجد تذاكر بعد.";
  const open = db.prepare(`SELECT number,user_id,type,created_at FROM tickets WHERE status='open' ORDER BY created_at DESC LIMIT 10`).all();
  const openList = open.length ? open.map(t => `**#${t.number}** · ${t.type} · <@${t.user_id}>`).join("\n") : "لا توجد تذاكر مفتوحة.";
  return {
    embeds: [embed("📈 إحصائيات التذاكر", [
      `**الكل:** ${s.total} · **مفتوحة:** ${s.open} · **مغلقة:** ${s.closed} · **اليوم:** ${s.today}`,
      "",
      "**حسب النوع:**",
      byType,
      "",
      "**مفتوحة الآن:**",
      openList,
    ].join("\n"))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:ticket-stats").setLabel("🔄 تحديث").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary),
    )],
  };
}

// ─────────── قسم الرتب التلقائية ───────────
// نفس مبدأ قسم الرومات: نعرض الرتبة المحفوظة كقيمة مختارة، ونعيد رسم القسم بعد الحفظ.
function autorolesSection(statusText) {
  config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
  const a = config.autoRoles;
  const memberSel = new RoleSelectMenuBuilder().setCustomId("autorole_select:member")
    .setPlaceholder(a.memberRoleId ? `👤 رتبة الأعضاء — الحالية: <@&${a.memberRoleId}>` : "👤 رتبة الأعضاء — غير محددة")
    .setMinValues(0).setMaxValues(1);
  if (a.memberRoleId) memberSel.setDefaultRoles([a.memberRoleId]);
  const botSel = new RoleSelectMenuBuilder().setCustomId("autorole_select:bot")
    .setPlaceholder(a.botRoleId ? `🤖 رتبة البوتات — الحالية: <@&${a.botRoleId}>` : "🤖 رتبة البوتات — غير محددة")
    .setMinValues(0).setMaxValues(1);
  if (a.botRoleId) botSel.setDefaultRoles([a.botRoleId]);
  const rows = [
    new ActionRowBuilder().addComponents(memberSel),
    new ActionRowBuilder().addComponents(botSel),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:autoroles-toggle").setLabel(`${a.enabled ? "✅" : "❌"} ${a.enabled ? "إيقاف الرتب التلقائية" : "تفعيل الرتب التلقائية"}`).setStyle(a.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 الرئيسية").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed("🏷️ الرتب التلقائية", [
    `**الحالة:** ${a.enabled ? "✅ مفعّل" : "❌ معطّل"}`,
    `**رتبة الأعضاء:** ${a.memberRoleId ? `<@&${a.memberRoleId}>` : "غير محددة"}`,
    `**رتبة البوتات:** ${a.botRoleId ? `<@&${a.botRoleId}>` : "غير محددة"}`,
    "",
    "اختر الرتب من القوائم بالأسفل — تُحفظ فوراً.",
    "البوت يحتاج صلاحية **إدارة الرتب**، ورتبته تكون فوق الرتب المختارة.",
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
  const e = embed("D7 Dev • Admin Dashboard", "Live store overview. Use the admin commands to manage products and orders.")
    .addFields(
      { name: "Confirmed orders", value: String(totalOrders), inline: true },
      { name: "Pending orders", value: String(pending), inline: true },
      { name: "Recorded revenue", value: formatPrice(revenue), inline: true },
      { name: "Open tickets", value: String(openTickets), inline: true },
      { name: "Best sellers", value: body }
    );
  const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
  const old = messages?.find(m => m.author.id === client.user.id && m.embeds[0]?.title === "D7 Dev • Admin Dashboard");
  if (old) await old.edit({ embeds: [e] }).catch(() => {});
  else await channel.send({ embeds: [e] }).catch(() => {});
}

// ─────────── تأكيد طلب: يعطي الرول وينبّه روم الطلبات ───────────
async function confirmOrder(interaction, id) {
  const order = db.prepare("SELECT o.*, p.name, p.role_id, p.price, p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?").get(id);
  if (!order) return interaction.reply({ content: "الطلب غير موجود.", ephemeral: true });
  if (order.status !== "pending") return interaction.reply({ content: `هذا الطلب حالته **${order.status}** بالفعل.`, ephemeral: true });
  const guild = interaction.guild;
  const member = await guild.members.fetch(order.user_id).catch(() => null);
  if (!member) return interaction.reply({ content: "العميل مو عضو في هذا السيرفر.", ephemeral: true });
  if (order.role_id) {
    // تأكيد الدفع من الموظف نفسه → ما نطلب تأكيداً ثانياً قبل رسالة التقييم
    preApprove(order.user_id, order.product_id);
    await member.roles.add(order.role_id, `D7 Dev order #${id} confirmed`).catch(() => {});
  }
  db.prepare("UPDATE orders SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,confirmed_by=? WHERE id=?").run(interaction.user.id, id);
  if (config.purchase.sendThankYouDM) {
    await member.send({ embeds: [embed("Thank you for your purchase!", `Your purchase of **${order.name}** has been confirmed.\nOrder: #${id}\nProduct role: ${order.role_id ? `<@&${order.role_id}>` : "No role configured"}`)] }).catch(() => {});
  }
  // رسالة التقييم ترسل من مستمع رتب المنتجات (أدناه) — نفس النضام المستخدم في NSR Hub
  // إشعار روم الطلبات: "فلان اشترى هذا المنتج"
  await sendToConfiguredChannel(guild, "orders", {
    embeds: [embed("🛒 شراء جديد", [
      `**اشترى العضو:** <@${order.user_id}>`,
      `**المنتج:** ${order.name}`,
      `**السعر:** ${formatPrice(order.price, order.currency)}`,
      `**الطلب:** #${id}`,
      order.role_id ? `**الرول المُعطي:** <@&${order.role_id}>` : "",
      `**أكده:** ${interaction.user}`,
    ].filter(Boolean).join("\n"))],
  });
  await refreshAdminDashboard(guild);
  return interaction.reply({ content: `✅ تم تأكيد الطلب #${id} وأعطيت ${member} رول **${order.name}**.`, ephemeral: true });
}

// ─────────── إضافة منتج: الرتبة ← السعر ← الاسم ───────────
function productRoleStep() {
  return {
    embeds: [embed("🛍️ إضافة منتج", "**اختار الرتبة**\nالرتبة تُعطى للعميل بعد تأكيد الدفع.")],
    components: [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId("d7_prod_role").setPlaceholder("اختار الرتبة").setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("d7_prod_role_skip").setLabel("بدون رتبة").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("d7_prod_role_cancel").setLabel("إلغاء").setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

function productPriceModal() {
  const modal = new ModalBuilder().setCustomId("panel_modal:add-price").setTitle("حط السعر");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("price").setLabel("حط السعر").setPlaceholder("مثال: 150 أو 150.50")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
  ));
  return modal;
}

function productNameModal() {
  const modal = new ModalBuilder().setCustomId("panel_modal:add-name").setTitle("اسم المنتج");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("name").setLabel("اسم المنتج").setPlaceholder("مثال: Dev Pack")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
  ));
  return modal;
}

// بعد اختيار الرتبة → نافذة السعر (أو الاسم مباشرة لو السعر معطوف في الأمر)
function productAfterRole(interaction) {
  const pending = pendingProduct.get(interaction.user.id);
  if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
  if (pending.price === null) return interaction.showModal(productPriceModal());
  if (pending.name === null) return interaction.showModal(productNameModal());
  return finishProduct(interaction);
}

function productNameStep() {
  return {
    content: "✅ تم حفظ السعر. الآن اضغط لإدخال اسم المنتج:",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_prod_name_step").setLabel("📝 اسم المنتج").setStyle(ButtonStyle.Primary)
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
  if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
  pendingProduct.delete(interaction.user.id);
  const name = String(pending.name || "").trim();
  const price = Number(pending.price);
  if (!name) return interaction.reply({ content: "❌ اسم المنتج مطلوب.", ephemeral: true });
  if (!Number.isFinite(price) || price < 0) return interaction.reply({ content: "السعر لازم يكون رقم صحيح، مثال: 150 أو 150.50", ephemeral: true });
  const res = db.prepare("INSERT INTO products (name,price,role_id) VALUES (?,?,?)").run(name, price, pending.roleId || "");
  const message = `✅ أُضيف المنتج **${name}** برقم \`#${res.lastInsertRowid}\` — ${formatPrice(price)}${pending.roleId ? `\nالرتبة: <@&${pending.roleId}>` : "\nبدون رتبة"}`;
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
  const badge = status === "approved" ? "✅ **تم التأكيد** — أُرسلت رسالة التقييم."
    : status === "rejected" ? "❌ **تم الرفض** — لم تُرسل أي رسالة."
    : "⏳ **بانتظار التأكيد** — هل هذا العضو اشترى المنتج فعلاً؟";
  const rows = status === "pending"
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`d7_pcheck:${id}:ok`).setLabel("✅ تأكيد").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`d7_pcheck:${id}:no`).setLabel("❌ رفض").setStyle(ButtonStyle.Danger),
      )]
    : [];
  return {
    embeds: [embed("🛒 تأكيد شراء منتج", [
      `**العضو:** <@${userId}>`,
      `**المنتج:** ${product?.name || "غير معروف"}${product?.name ? ` — ${formatPrice(product.price)}` : ""}`,
      "",
      badge,
      decidedBy ? `**بواسطة:** <@${decidedBy}>` : "",
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
  console.log(`D7 Dev bot online as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) await refreshAdminDashboard(guild);
});

client.on(Events.GuildMemberAdd, async member => {
  // Configurable automatic roles: separate roles for human members and bots.
  if (config.autoRoles?.enabled) {
    const roleId = member.user.bot ? config.autoRoles.botRoleId : config.autoRoles.memberRoleId;
    if (roleId && member.guild.roles.cache.has(roleId)) {
      await member.roles.add(roleId, "D7 Dev automatic join role").catch(err => console.error("Auto-role assignment failed:", err.message));
    }
  }
  if (!config.welcome?.enabled) return;
  const channel = channelFromConfig(member.guild, "welcome");
  if (!channel?.isTextBased()) return;
  const message = (config.welcome.message || "Welcome {user}").replaceAll("{user}", `<@${member.id}>`).replaceAll("{server}", member.guild.name);
  const e = embed("Welcome to D7 Dev", message);
  if (config.welcome.imageUrl) e.setImage(config.welcome.imageUrl);
  await channel.send({ content: `<@${member.id}>`, embeds: [e] }).catch(() => {});
});

client.on(Events.InteractionCreate, async interaction => {
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
      const { commandName } = interaction;
      if (commandName === "panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        return interaction.reply({ ...mainPanel(), ephemeral: true });
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
        if (!target || target.bot) return interaction.reply({ content: "❌ اختر عميلاً حقيقياً (وليس بوتاً).", ephemeral: true });
        const all = ratings.getProducts();
        if (!all.length) return interaction.reply({ content: "❌ لا توجد منتجات بعد — أضف منتجاً من لوحة التحكم أولاً.", ephemeral: true });
        const raw = interaction.options.getString("product", true);
        const product = ratings.findProduct(interaction.guildId, raw);
        if (!product) return interaction.reply({ content: "❌ المنتج غير موجود. المنتجات المتاحة:\n" + all.map(p => `• **${p.name}**`).join("\n"), ephemeral: true });
        const ok = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
        if (!ok) return interaction.reply({ content: `❌ تعذر إرسال رسالة خاصة إلى ${target} — ربما قفل الخاص.`, ephemeral: true });
        return interaction.reply({ content: `✅ تم إرسال رسالة تقييم **«${product.name}»** إلى ${target} على الخاص.`, ephemeral: true });
      }
      if (commandName === "product-edit") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = interaction.options.getInteger("id", true);
        const status = interaction.options.getString("status", true);
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(id);
        if (!product) return interaction.reply({ content: "Product not found.", ephemeral: true });
        db.prepare("UPDATE products SET status=? WHERE id=?").run(status, id);
        return interaction.reply({ content: `Updated **${product.name}** status to **${status}**.`, ephemeral: true });
      }
      if (commandName === "product-panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        if (!products.length) return interaction.reply({ content: "Add products first using /product-add.", ephemeral: true });
        return interaction.reply({
          embeds: [embed("🛍️ نشر المنتجات", `في ${Math.min(products.length, 10)} منتج.\nاختر الروم الذي تريد نشر المنتجات فيه.`)],
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
            .setCustomId("d7_showcase_channel").setPlaceholder("اختر روم عرض المنتجات")
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
        return interaction.reply({ embeds: [embed("Order created", `Order #${result.lastInsertRowid}\nCustomer: ${user}\nProduct: **${product.name}**\nUse /order-confirm to confirm payment and grant the product role.`)], ephemeral: true });
      }
      if (commandName === "order-confirm") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        return confirmOrder(interaction, interaction.options.getInteger("order_id", true));
      }
      if (commandName === "order-deliver") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = interaction.options.getInteger("order_id", true);
        const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
        if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
        const now = Date.now();
        const start = order.confirmed_at ? new Date(order.confirmed_at.replace(" ", "T") + "Z").getTime() : now;
        db.prepare("UPDATE orders SET status='delivered',delivered_at=CURRENT_TIMESTAMP,delivery_seconds=? WHERE id=?").run(Math.max(0, Math.floor((now-start)/1000)), id);
        await refreshAdminDashboard(interaction.guild);
        return interaction.reply({ content: `Order #${id} marked as delivered.`, ephemeral: true });
      }
      if (commandName === "orders") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const rows = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
        const description = rows.length ? rows.map(o => `**#${o.id} — ${o.product_name}**\nCustomer: <@${o.user_id}> • ${o.status} • ${o.created_at}${o.delivery_seconds !== null ? ` • ${Math.floor(o.delivery_seconds/60)}m ${o.delivery_seconds%60}s` : ""}\nRating: ${o.rating ? `${o.rating}/5` : "Not rated"}`).join("\n\n") : "No orders yet.";
        return interaction.reply({ embeds: [embed("Recent Orders", description)], ephemeral: true });
      }
      if (commandName === "dashboard-refresh") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        await refreshAdminDashboard(interaction.guild);
        return interaction.reply({ content: "Dashboard refreshed where configured.", ephemeral: true });
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
        ? `✅ تم حفظ ${target === "member" ? "رتبة الأعضاء" : "رتبة البوتات"}: <@&${roleId}>.`
        : `🗑️ تم مسح ${target === "member" ? "رتبة الأعضاء" : "رتبة البوتات"}.`));
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
          return interaction.reply({ content: "اختر الروم الذي تريد نشر المنتجات فيه:", components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("d7_showcase_channel").setPlaceholder("اختر روم عرض المنتجات").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1))] });
        }
        if (section === "products-list") return interaction.update(productsSection());
        if (section === "delete-product") {
          const rows = productDeleteRows();
          if (!rows) return interaction.reply({ content: "لا توجد منتجات لحذفها.", ephemeral: true });
          return interaction.update({
            embeds: [embed("🗑️ حذف منتج", "**اختر المنتج من القائمة بالأسفل.**\n⚠️ الحذف نهائي ولا يمكن التراجع عنه.\nالمنتجات التي لديها طلبات مسجلة لا يمكن حذفها حفاظاً على سجل المبيعات.")],
            components: rows,
          });
        }
        if (section === "orders") return interaction.update(ordersSection());
        if (section === "tickets") return interaction.update(ticketsSection());
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
          if (!enabled.length) return interaction.reply({ content: "❌ لا توجد أنواع تذاكر مفعّلة — فعّل نوعاً واحداً على الأقل من إعدادات التذاكر.", ephemeral: true });
          try {
            await interaction.channel.send({ embeds: [tickets.panelEmbed()], components: tickets.panelRows() });
          } catch (err) {
            return interaction.reply({ content: `❌ تعذر الإرسال في هذا الروم.\nتأكد أن البوت يملك صلاحية **إرسال الرسائل** هنا.\n\n\`${err.message}\``, ephemeral: true });
          }
          return interaction.reply({ content: `✅ تم إرسال لوحة التذاكر إلى <#${interaction.channel.id}>!`, ephemeral: true });
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
          const modal = new ModalBuilder().setCustomId("panel_modal:welcome").setTitle("Welcome Settings");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("body").setLabel("Welcome text ({user}, {server})").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Direct image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
          return interaction.showModal(modal);
        }
        if (section === "autoroles") return interaction.update(autorolesSection());
        if (section === "autoroles-toggle") {
          config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
          config.autoRoles.enabled = !config.autoRoles.enabled;
          saveConfig();
          return interaction.update(autorolesSection(config.autoRoles.enabled ? "✅ تم تفعيل الرتب التلقائية — تُعطى عند دخول عضو جديد." : "❌ تم إيقاف الرتب التلقائية."));
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
        await interaction.reply({ content: `Purchase request created: **Order #${result.lastInsertRowid}**. A staff member must confirm payment before the product role is granted.`, ephemeral: true });
        const notifyKey = safeChannelId(config.channels?.orders) ? "orders" : "salesLogs";
        await sendToConfiguredChannel(interaction.guild, notifyKey, { embeds: [embed("New purchase request", `Order #${result.lastInsertRowid}\nCustomer: ${interaction.user}\nProduct: **${p.name}**\nPrice: ${formatPrice(p.price,p.currency)}\nConfirm using /order-confirm order_id:${result.lastInsertRowid}`)] });
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
      if (!check) return interaction.reply({ content: "❌ هذا الطلب غير موجود.", ephemeral: true });
      if (check.status !== "pending") return interaction.reply({ content: `هذا الطلب تم ${check.status === "approved" ? "تأكيده" : "رفضه"} بالفعل.`, ephemeral: true });
      const approved = decision === "ok";
      // نحدّد الحالة أولاً حتى لا يمراره اثنان في نفس اللحظة
      const changed = db.purchaseChecks.decide(check.id, approved ? "approved" : "rejected", interaction.user.id);
      if (!changed.changes) return interaction.reply({ content: "سبق وتم اتخاذ القرار لهذا الطلب.", ephemeral: true });
      const product = ratings.getProducts().find(p => p.id === String(check.product_id)) || null;
      let dmSent = false;
      if (approved) {
        const target = await interaction.client.users.fetch(check.user_id).catch(() => null);
        if (target && !target.bot) dmSent = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
      }
      // نحدّث الرسالة نفسها: نخفي الأزرار ونوضح النتيجة
      if (check.message_id && interaction.channel?.messages) {
        const msg = await interaction.channel.messages.fetch(check.message_id).catch(() => null);
        if (msg) await msg.edit(purchaseCheckPayload(check.id, check.user_id, product, approved ? "approved" : "rejected", interaction.user.id)).catch(() => {});
      }
      const lines = [
        approved
          ? `✅ تم تأكيد شراء <@${check.user_id}> لمنتج **${product?.name || "غير معروف"}**.`
          : `❌ تم رفض تأكيد شراء <@${check.user_id}> — لم تُرسل له أي رسالة.`,
      ];
      if (approved && !dmSent) lines.push("⚠️ تعذر إرسال رسالة التقييم للخاص — ربما قفلها العضو.");
      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    // ─────────── اختيار رتبة المنتج ثم السعر ثم الاسم ───────────
    if (interaction.isRoleSelectMenu() && interaction.customId === "d7_prod_role") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pending = pendingProduct.get(interaction.user.id);
      if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
      pending.roleId = interaction.values[0];
      return productAfterRole(interaction);
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_role_skip") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pending = pendingProduct.get(interaction.user.id);
      if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
      pending.roleId = "";
      return productAfterRole(interaction);
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_role_cancel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      pendingProduct.delete(interaction.user.id);
      return respondWith(interaction, { ...productsSection(), content: "❌ تم إلغاء إضافة المنتج." });
    }
    if (interaction.isButton() && interaction.customId === "d7_prod_name_step") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      if (!pendingProduct.has(interaction.user.id)) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
      return interaction.showModal(productNameModal());
    }

    // ─────────── حذف منتج نهائياً ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_prod_del_sel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const id = Number(interaction.values[0]);
      const product = db.prepare("SELECT * FROM products WHERE id=?").get(id);
      if (!product) return interaction.reply({ content: "❌ المنتج غير موجود.", ephemeral: true });
      // المنتجات التي لديها طلبات مسجلة ما نحذفها — حفاظاً على سجل المبيعات
      // (وأصلاً: جدول الطلبات مرتبط بالمنتج بمفتاح خارجي)
      const orderCount = db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id=?").get(id).n;
      if (orderCount) {
        return interaction.reply({ content: `❌ لا يمكن حذف **${product.name}** — لديه ${orderCount} طلب مسجل.\nحذفه سيفقد سجل المبيعات. يمكنك إيقافه من تعديل المنتج بدلاً من ذلك.`, ephemeral: true });
      }
      // ننظف بيانات المنتج: التقييمات والمشاهدات
      db.prepare("DELETE FROM ratings WHERE product_id=?").run(String(id));
      db.prepare("DELETE FROM product_reviews WHERE product_id=?").run(id);
      db.prepare("DELETE FROM purchase_checks WHERE product_id=?").run(String(id));
      db.prepare("DELETE FROM products WHERE id=?").run(id);
      return respondWith(interaction, { ...productsSection(), content: `🗑️ تم حذف المنتج **${product.name}** نهائياً.` });
    }

    // ─────────── اختيار روم نشر المنتجات ───────────
    if (interaction.isChannelSelectMenu() && interaction.customId === "d7_showcase_channel") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const channelId = interaction.values[0];
      config.channels ||= {};
      config.channels.productShowcase = channelId;
      saveConfig();
      const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
      let sent = 0;
      for (const product of products.slice(0, 10)) {
        await interaction.guild.channels.cache.get(channelId)?.send({ embeds: [productEmbed(product)], components: productPanelRows(product.id) }).then(() => sent++).catch(() => {});
      }
      return interaction.reply({ content: `✅ تم نشر ${sent} منتج في <#${channelId}>.`, ephemeral: true });
    }

    // ─────────── اختيار رومات التنبيهات والنشر ───────────
    if (interaction.isChannelSelectMenu() && (interaction.customId.startsWith("d7_ch_") || interaction.customId === "d7_order_ch" || interaction.customId === "d7_ratings_ch")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      // ملاحظة: "d7_ch_reviews" محفوظ للتوافق مع لوحات منشورة سابقاً —
      // القائمة نفسها شلتناها من قسم الرومات (صارت في قسم التقييمات فقط).
      const map = { "d7_ch_orders": "orders", "d7_ch_sales": "salesLogs", "d7_ch_showcase": "productShowcase", "d7_ch_reviews": "reviews", "d7_order_ch": "orders", "d7_ratings_ch": "reviews", "d7_pcheck_ch": "purchaseChecks" };
      const key = map[interaction.customId];
      if (!key) return;
      config.channels ||= {};
      config.channels[key] = interaction.values[0];
      saveConfig();
      // نعيد رسم نفس القسم بدل رد مؤقت — عشان يظهر الاختيار محفوظ فوراً
      if (interaction.customId === "d7_order_ch") return interaction.update(ordersSection());
      if (interaction.customId === "d7_ratings_ch") return interaction.update(ratingsSection());
      return interaction.update(channelsSection());
    }

    // ─────────── لوحة التذاكر: فتح تذكرة ───────────
    if (interaction.isStringSelectMenu() && interaction.customId === "d7_ticket_type") {
      return tickets.handleSelect(interaction);
    }

    // ─────────── نظام التقييمات (نسخة من NSR Hub) ───────────
    if (interaction.isButton() && interaction.customId.startsWith("rate_lang_")) return ratings.handleLangButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("rate_star_")) return ratings.handleStarButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("rate_comment_")) return ratings.handleCommentModal(interaction);
    if (interaction.isButton() && interaction.customId === "d7_rate_send") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const modal = new ModalBuilder().setCustomId("d7_rate_send_modal").setTitle("إرسال تقييم لعميل");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("معرف العضو (User ID)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("product").setLabel("اسم المنتج أو رقمه").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      );
      return interaction.showModal(modal);
    }

    // ─────────── الصلاحيات ───────────
    if (interaction.isButton() && interaction.customId === "d7_perm_admins") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const ids = (config.permissions?.adminUserIds || []).join(", ");
      const modal = new ModalBuilder().setCustomId("d7_perm_admins_modal").setTitle("مدراء البوت");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ids").setLabel("معرفات المدراء (مفصولة بفاصلة)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder(ids || "123456789012345678").setMaxLength(1000)
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
      if (!tp) return interaction.reply({ content: "❌ النوع غير موجود.", ephemeral: true });
      tp.enabled = tp.enabled === false;
      tickets.saveConfig();
      await interaction.update(ticketsSection());
      return interaction.followUp({ content: `${tp.enabled === false ? "❌ تم إخفاء" : "✅ تم إظهار"} نوع «${tp.label}».\nأعد إرسال لوحة التذاكر لتطبيق التغيير.`, ephemeral: true }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_add") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const modal = new ModalBuilder().setCustomId("d7_tk_add_modal").setTitle("➕ إضافة نوع تذكرة");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_name").setLabel("اسم النوع").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setPlaceholder("مثال: Purchase")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_desc").setLabel("الوصف").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder("مثال: Inquire about buying a product or service")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_emoji").setLabel("الإيموجي (حرف واحد)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder("مثال: 🛒")),
      );
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_del") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const custom = tickets.types().filter(x => String(x.id || "").startsWith("c"));
      if (!custom.length) {
        return interaction.reply({ content: "🗑️ لا توجد أنواع مخصصة للحذف — الأنواع العامة لا تُحذف.", ephemeral: true });
      }
      await interaction.update({ embeds: [interaction.message.embeds[0]], components: ticketDeleteRows() });
      return interaction.followUp({ content: "🗑️ اختر النوع المخصص الذي تريد حذفه من القائمة بالأسفل.", ephemeral: true }).catch(() => {});
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
        return interaction.followUp({ content: "❌ هذا النوع عام ولا يمكن حذفه.", ephemeral: true }).catch(() => {});
      }
      tickets.ensureConfig().ticketTypes = all.filter(x => x.id !== typeId);
      tickets.saveConfig();
      await interaction.update(ticketsSection());
      return interaction.followUp({ content: `🗑️ تم حذف نوع «${tp.label}». أرسل اللوحة لتطبيق التغيير.`, ephemeral: true }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === "d7_tk_text") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const t = tickets.ensureConfig();
      const modal = new ModalBuilder().setCustomId("d7_tk_text_modal").setTitle("نص لوحة التذاكر");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_title").setLabel("عنوان اللوحة").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder((t.panel?.title || "🎫 Support Tickets").slice(0, 100)).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_body").setLabel("وصف اللوحة").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("Welcome to our support system! ...").setMaxLength(900)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tk_footer").setLabel("الفوتر (اختياري)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder((t.panel?.footer || config.brand?.footer || "D7 Dev").slice(0, 100)).setMaxLength(100)),
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
      if (!name || !desc) return interaction.reply({ content: "❌ اسم النوع والوصف مطلوبان.", ephemeral: true });
      const t = tickets.ensureConfig();
      const tp = { id: "c" + Date.now().toString(36), label: name, description: desc, color: 0x57F287, enabled: true };
      if (emoji && /^\p{Extended_Pictographic}$/u.test(emoji)) tp.emoji = emoji;
      else if (emoji) tp.emoji = "";
      t.ticketTypes.push(tp);
      tickets.saveConfig();
      await interaction.reply({ content: `✅ تم إضافة نوع «${name}». أرسل اللوحة لتطبيق التغيير.`, ephemeral: true });
      return interaction.message?.edit(ticketsSection()).catch(() => {});
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_tk_text_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const t = tickets.ensureConfig();
      t.panel ||= {};
      t.panel.title = interaction.fields.getTextInputValue("tk_title").trim();
      t.panel.description = interaction.fields.getTextInputValue("tk_body").trim();
      t.panel.footer = (interaction.fields.getTextInputValue("tk_footer") || "").trim() || config.brand?.footer || "D7 Dev";
      tickets.saveConfig();
      await interaction.reply({ content: "✅ تم حفظ نص لوحة التذاكر.", ephemeral: true });
      return interaction.message?.edit(ticketsSection()).catch(() => {});
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_rate_send_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const userId = interaction.fields.getTextInputValue("user").trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content: "❌ معرف عضو غير صالح.", ephemeral: true });
      const raw = interaction.fields.getTextInputValue("product").trim();
      const product = ratings.findProduct(interaction.guildId, raw);
      if (!product) return interaction.reply({ content: "❌ المنتج غير موجود. المنتجات المتاحة:\n" + ratings.getProducts().map(p => `• **${p.name}**`).join("\n"), ephemeral: true });
      const target = await interaction.client.users.fetch(userId).catch(() => null);
      if (!target || target.bot) return interaction.reply({ content: "❌ لم يتم العثور على عضو حقيقي.", ephemeral: true });
      const ok = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
      if (!ok) return interaction.reply({ content: `❌ تعذر إرسال رسالة خاصة إلى ${target} — ربما قفل الخاص.`, ephemeral: true });
      return interaction.reply({ content: `✅ تم إرسال رسالة تقييم **«${product.name}»** إلى ${target} على الخاص.`, ephemeral: true });
    }
    if (interaction.isModalSubmit() && interaction.customId === "d7_perm_admins_modal") {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const ids = (interaction.fields.getTextInputValue("ids") || "").split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));
      config.permissions ||= {};
      config.permissions.adminUserIds = ids;
      saveConfig();
      await interaction.reply({ content: `✅ تم حفظ ${ids.length} مدير بوت.`, ephemeral: true });
      return interaction.message?.edit(permsSection()).catch(() => {});
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("panel_modal:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const kind = interaction.customId.split(":")[1];
      if (kind === "add-price") {
        const price = Number(interaction.fields.getTextInputValue("price").replace(/,/g, ""));
        if (!Number.isFinite(price) || price < 0) return interaction.reply({ content: "السعر لازم يكون رقم صحيح، مثال: 150 أو 150.50", ephemeral: true });
        const pending = pendingProduct.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
        pending.price = price;
        if (pending.name === null || pending.name === undefined) return respondWith(interaction, productNameStep());
        return finishProduct(interaction);
      }
      if (kind === "add-name") {
        const pending = pendingProduct.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: "انتهت مهلة إضافة المنتج. أعد الأمر /product-add.", ephemeral: true });
        pending.name = interaction.fields.getTextInputValue("name").trim();
        return finishProduct(interaction);
      }
      if (kind === "welcome") {
        config.welcome.message = interaction.fields.getTextInputValue("body");
        config.welcome.imageUrl = (interaction.fields.getTextInputValue("image") || "").trim();
        fs.writeFileSync(path.join(__dirname, "..", "config.json"), JSON.stringify(config, null, 2));
        return interaction.reply({ content: "Welcome message and image saved.", ephemeral: true });
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
        db.prepare("UPDATE orders SET rating=?,review=? WHERE id=?").run(rating, review, id);
        db.prepare("INSERT OR REPLACE INTO product_reviews (order_id,user_id,product_id,rating,review) VALUES (?,?,?,?,?)").run(id, interaction.user.id, order.product_id, rating, review);
        await sendToConfiguredChannel(interaction.guild, "reviews", { embeds: [embed("Product review", `Product: **${order.product_name}**\nCustomer: <@${interaction.user.id}>\nRating: ${rating}/5\nReview: ${review || "No written comment."}`)] });
        await refreshAdminDashboard(interaction.guild);
        return interaction.reply({ content: "Thank you! Your product review has been saved.", ephemeral: true });
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const message = { content: "Something went wrong. Check the bot console and config.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(message).catch(() => {});
    else await interaction.reply(message).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
