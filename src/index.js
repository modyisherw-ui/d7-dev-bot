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
    new ActionRowBuilder().addComponents(channelRow("d7_welcome_ch", "welcome", `👋 Welcome channel (fallback) — current: ${chLabel("welcome")}`)),
    // ⚠️ روم التقييمات ما عاد هنا — صار في قسم التقييمات فقط حتى ما يتكرر
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Back to menu").setStyle(ButtonStyle.Secondary)),
  ];
  return { embeds: [embed("📌 Channels", "Pick the right channel in each menu — saved instantly.\nThe ratings channel is set from **⭐ Ratings**.")], components: rows };
}

// ─────────── قسم الترحيب ───────────
// رسالة الترحيب تُرسل للعضو على **الخاص**، وإن فشل الخاص تُنشر في روم الترحيب المحدد.
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
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_store", w.storeChannelId, `🏪 Store channel — ${w.storeChannelId ? `<#${w.storeChannelId}>` : "Not set"}`)),
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_help", w.helpChannelId, `🆘 Help channel (Need Help) — ${w.helpChannelId ? `<#${w.helpChannelId}>` : "Not set"}`)),
    new ActionRowBuilder().addComponents(welcomeChannelRow("d7_welcome_releases", w.releasesChannelId, `🚀 Latest Releases channel — ${w.releasesChannelId ? `<#${w.releasesChannelId}>` : "Not set"}`)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:welcome:toggle").setLabel(w.enabled === false ? "❌ Welcome: off" : "✅ Welcome: on").setStyle(w.enabled === false ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:welcome:mode").setLabel(w.sendDM === false ? "🗨️ Send: welcome channel" : "📨 Send: member DM").setStyle(w.sendDM === false ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel:welcome:text").setLabel("✏️ Text & title").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:welcome:image").setLabel("🖼️ Image").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
  // المعاينة = رسالة الترحيب نفسها بالضبط
  const preview = welcomePayload();
  const meta = [
    `**Welcome channel (fallback):** ${chLabel("welcome")} — used if the member keeps DMs closed.`,
  ];
  return { content: [statusText, ...meta].filter(Boolean).join("\n"), embeds: preview.embeds, components: rows };
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

// ─────────── قسم الطلبات (مع اختيار روم إرسال الطلبات) ───────────
function ordersSection() {
  const rowsData = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
  const desc = rowsData.length
    ? rowsData.map(o => `**#${o.id}** · ${o.product_name} · <@${o.user_id}> · **${o.status}** · ${formatPrice(o.price,o.currency)}\n⭐ ${o.rating ? `${o.rating}/5` : "no rating"}`).join("\n")
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
  // ⬇️ سجل الطلبات: كل طلب وكل تغيير حالة ينزل برسالته الخاصة
  // ملاحظة: الـ placeholder يظهر فقط لما ما يكون فيه روم محفوظ —
  // ولو كان محفوظاً يظهر اسمه داخل القائمة مكانها، عشان كذا نذكره في نص الرسالة.
  rows.push(new ActionRowBuilder().addComponents(channelRow("d7_order_ch", "orders", "🛒 Pick the purchase log channel")));
  // ⬇️ روم حالة الطلب: منفصل عن روم تسجيل الشراء عشان كل روم وظيفته وحدة —
  // روم الشراء يسجّل إن الرتبة طلعت، وروم الحالة يتابع الطلب للنهاية.
  rows.push(new ActionRowBuilder().addComponents(channelRow("d7_order_status_ch", "orderStatus", "🚚 Pick the order status channel")));
  // ⬇️ روم حالة المنتجات: /product-edit ينزل فيه رسالة لكل تغيير حالة
  // (بلا روم محفوظ يظهر الـ placeholder، عشان يبان من أول مرة)
  rows.push(new ActionRowBuilder().addComponents(channelRow("d7_prod_status_ch", "productStatus", "🔄 Pick the product status channel")));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:orders").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:home").setLabel("🔙 Home").setStyle(ButtonStyle.Secondary)
  ));
  // ديسكورد يخفي تسمية القائمة ما إن تحفظ قيمة داخلها ويعرض اسم الروم مكانها،
  // فتصير القائمتين متشابهتين تماماً ولا يعرف أحد أي واحدة لأي غرض.
  // عشان كذا نكتب الروم باسمه في نص الرسالة فوق القائمتين — هذا حصل فعلاً:
  // المستخدم ضبط روم حالة المنتجات وظن أن الطلبات ستصله.
  return { embeds: [embed("🧾 Orders", [
    desc,
    "",
    "Confirm payment from the menu above; the customer is granted the product role automatically.",
    `**🛒 Purchase log: ${chLabel("orders")}** — set by the menu below. Every purchase posts a message with the role, buyer and price.`,
    `**🚚 Order status: ${chLabel("orderStatus")}** — set by the menu below. Every confirmation, delivery or cancellation posts a new message with the order status.`,
    `**🔄 Product status: ${chLabel("productStatus")}** — set by the menu below. Every product status change posts a message.`,
  ].join("\n"))], components: rows.slice(0, 5) };
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

async function postOrderFeed(guild, order, extra) {
  // روم منفصل عن روم تسجيل الشراء: رسالة الشراء تسجّل الحدوث،
  // وهذي تتابع حالة الطلب (مؤكد / تم تسليمه / ملغى) — ما نخلطهم في مكان واحد.
  // ولو لم يُضبط روم الحالة بعد نرجع لروم الشراء بدل أن نفقد الرسالة:
  // إسقاطها بصمت أسوأ من أن تظهر في الروم المشترك، وهذا بالضبط ما حدث
  // سابقاً مع روم لم يكن في الكاش — الإشعار اختفى ولم يعترض أحد.
  const key = safeChannelId(config.channels?.orderStatus) ? "orderStatus" : "orders";
  return sendToConfiguredChannel(guild, key, { embeds: [orderFeedEmbed(order, extra)] }).catch(() => false);
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
  ].filter(Boolean).join("\n"));
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
  const guild = interaction.guild;
  const member = await guild.members.fetch(order.user_id).catch(() => null);
  if (!member) return interaction.reply({ content: "The buyer is not a member of this server.", ephemeral: true });
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
  return interaction.reply({ content: `✅ Confirmed order #${id} and granted ${member} the **${order.name}** role.`, ephemeral: true });
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
  const payload = welcomePayload();

  // الوضع الافتراضي: رسالة خاصة للعضو. ما نذكره — يعرف نفسه.
  if (config.welcome.sendDM !== false) {
    const sent = await member.send(payload).then(() => true).catch(() => false);
    if (sent) return;
    // فشل الخاص (العضو قافله) → نجرب روم الترحيب المحدد كاحتياطي.
  }

  const channel = channelFromConfig(member.guild, "welcome");
  if (!channel?.isTextBased()) return;
  await channel.send({ ...payload, content: `<@${member.id}>` }).catch(() => {});
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
        return interaction.reply({ embeds: [embed("Order created", `Order #${result.lastInsertRowid}\nCustomer: ${user}\nProduct: **${product.name}**\nUse /order-confirm to confirm payment and grant the product role.`)], ephemeral: true });
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
        // رسالة جديدة في سجل الطلبات تبيّن إن الحالة صارت "تم التنفيذ"
        await postOrderFeed(interaction.guild, order);
        await refreshAdminDashboard(interaction.guild);
        return interaction.reply({ content: `Order #${id} marked as delivered.`, ephemeral: true });
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
        await postOrderFeed(interaction.guild, order, { note: note || undefined });
        await refreshAdminDashboard(interaction.guild);
        return interaction.reply({ content: `Order #${id} cancelled.${order.role_id ? ` Note: the product role <@&${order.role_id}> was not removed.` : ""}`, ephemeral: true });
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
              ? "📨 The welcome message is DM'd to the member — if their DMs are closed it is posted in the welcome channel."
              : "🗨️ The welcome message is posted directly in the **welcome channel** set from the Channels section."));
          }
          if (flag === "text") {
            const w = ensureWelcome();
            const modal = new ModalBuilder().setCustomId("panel_modal:welcome_text").setTitle("Welcome message text");
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Title (Welcome to ...)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(String(w.title || ""))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("body").setLabel("Body").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000).setValue(String(w.message || ""))),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("footer").setLabel("Footer under the image (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(String(w.footer || ""))),
            );
            return interaction.showModal(modal);
          }
          if (flag === "image") {
            const w = ensureWelcome();
            const modal = new ModalBuilder().setCustomId("panel_modal:welcome_image").setTitle("Welcome image");
            modal.addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("url").setLabel("Direct image URL shown under the message").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(String(w.imageUrl || ""))),
            );
            return interaction.showModal(modal);
          }
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
        await interaction.reply({ content: `Purchase request created: **Order #${result.lastInsertRowid}**. A staff member must confirm payment before the product role is granted.`, ephemeral: true });
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
      const product = ratings.getProducts().find(p => p.id === String(check.product_id)) || null;
      let dmSent = false;
      if (approved) {
        const target = await interaction.client.users.fetch(check.user_id).catch(() => null);
        if (target && !target.bot) dmSent = await ratings.sendPurchaseDM(target, product, interaction.client, interaction.guild);
        // موافقة يدوية على منحة = شراء مكتمل — هذا هو المسار الذي لم يكن ينشر أبداً
        if (product) await postPurchaseFeed(interaction.guild, product, check.user_id, { approvedBy: interaction.user.id });
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
      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
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
      return interaction.reply({ content: `✅ Published ${sent} product(s) in <#${channelId}>.`, ephemeral: true });
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
      "d7_order_ch":      { key: "orders",           section: ordersSection },
      "d7_order_status_ch": { key: "orderStatus",    section: ordersSection },
      "d7_prod_status_ch": { key: "productStatus",   section: ordersSection },
      "d7_ratings_ch":    { key: "reviews",          section: ratingsSection },
      "d7_pcheck_ch":     { key: "purchaseChecks",   section: ratingsSection },
    };
    if (interaction.isChannelSelectMenu() && channelPickers[interaction.customId]) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const pick = channelPickers[interaction.customId];
      config.channels ||= {};
      config.channels[pick.key] = interaction.values[0];
      saveConfig();
      // نعيد رسم نفس القسم بدل رد مؤقت — عشان يظهر الاختيار محفوظ فوراً
      return interaction.update(pick.section());
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

    // ─────────── نظام التقييمات (نسخة من NSR Hub) ───────────
    if (interaction.isButton() && interaction.customId.startsWith("rate_lang_")) return ratings.handleLangButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("rate_star_")) return ratings.handleStarButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("rate_comment_")) return ratings.handleCommentModal(interaction);
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
