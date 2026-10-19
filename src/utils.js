const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const config = require("../config.json");

function embed(title, description = "") {
  return new EmbedBuilder()
    .setColor(config.brand.color || "#19D7CC")
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: config.brand.footer || "D7 Dev" })
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

module.exports = { embed, hasStaff, formatPrice, safeChannelId, cleanFileName };
