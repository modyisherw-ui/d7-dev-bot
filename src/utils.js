const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const config = require("../config.json");

// لون واحد لكل إيمبد في البوت
const EMBED_COLOR = 0x2fa2fa;
// شعار ثابت أعلى يمين كل إيمبد (مسار داخل المستودع العام).
// ?v=2 مقصود: ديسكورد يخزّن الصور الخارجية حسب الرابط الكامل، وبدون تغيير
// الرابط كان بيبقى عالق على النسخة القديمة (376x96) لوقت طويل
const EMBED_THUMB = "https://raw.githubusercontent.com/modyisherw-ui/d7-dev-bot/main/assets/s2a-logo.png?v=3";

function embed(title, description = "") {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(EMBED_THUMB)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: config.brand.footer || "S2A DEV" })
    .setTimestamp();
}

function hasStaff(member) {
  if (!member) return false;
  const roleIds = [...(config.roles.staff || []), ...(config.roles.admin || [])].filter(Boolean);
  if (config.permissions.adminUserIds?.includes(member.id)) return true;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return roleIds.some(id => member.roles?.cache?.has(id));
}

function formatPrice(price, currency = "SAR") {
  return `${Number(price).toLocaleString("en-US")} ${currency}`;
}

function safeChannelId(id) {
  return typeof id === "string" && /^\d{17,20}$/.test(id);
}

function cleanFileName(value) {
  return String(value || "transcript").replace(/[^a-z0-9-_]/gi, "_").slice(0, 80);
}

module.exports = { embed, hasStaff, formatPrice, safeChannelId, cleanFileName, EMBED_COLOR, EMBED_THUMB };
