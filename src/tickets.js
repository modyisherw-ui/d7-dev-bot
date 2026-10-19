// ═══════════════ نظام التذاكر (بنفس فكرة NSR Hub) ═══════════════
// لوحة اختيار نوع التذكرة → روم خاص لكل تذكرة → Claim / Summon / Close
// مع سجل (transcript) يُرسل لروم اللوق ونسخة خاصة لصاحب التذكرة.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const config = require("../config.json");
const { embed, safeChannelId, cleanFileName } = require("./utils");
const { AttachmentBuilder } = require("discord.js");

const CONFIG_FILE = path.join(__dirname, "..", "config.json");
const TICKET_COLOR = 0x0099ff; // أزرق ثابت للتذاكر

function ensureConfig() {
  config.tickets ||= {};
  config.tickets.panel ||= { title: "🎫 D7 Dev Support", description: "اختر نوع التذكرة من القائمة بالأسفل." };
  config.tickets.staffRoles ||= [];
  config.tickets.ticketTypes ||= [];
  config.tickets.categoryId ||= "";
  config.tickets.logChannelId ||= "";
  return config.tickets;
}

function saveConfig() {
  ensureConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const DEFAULT_TYPES = [
  { id: "purchase", label: "Purchase", description: "Inquire about buying a product or service", emoji: "🛒", enabled: true },
  { id: "inquiry", label: "Inquiry", description: "General question or inquiry", emoji: "💬", enabled: true },
  { id: "problem", label: "Problem", description: "Report a bug or issue", emoji: "🚧", enabled: true },
  { id: "report", label: "Report a User", description: "Report a user or issue", emoji: "🚨", enabled: false },
];

function types() {
  const t = ensureConfig();
  if (!t.ticketTypes.length) {
    t.ticketTypes = DEFAULT_TYPES.map(x => ({ ...x }));
    saveConfig();
  }
  return t.ticketTypes;
}

// ─────────── لوحة التذاكر العامة ───────────
function panelRows() {
  const enabled = types().filter(t => t.enabled !== false);
  const select = new StringSelectMenuBuilder()
    .setCustomId("d7_ticket_type")
    .setPlaceholder("Select a ticket type...")
    .addOptions(enabled.map(t => {
      const opt = new StringSelectMenuOptionBuilder().setLabel(t.label).setDescription(t.description || "Ticket").setValue(t.id);
      if (t.emoji && /^\p{Extended_Pictographic}$/u.test(t.emoji.trim())) opt.setEmoji(t.emoji.trim());
      return opt;
    }));
  return [new ActionRowBuilder().addComponents(select)];
}

function panelEmbed() {
  const t = ensureConfig();
  const p = t.panel || {};
  const enabled = types().filter(x => x.enabled !== false);
  const lines = enabled.map(tp => `> ${tp.emoji || ""} **${tp.label}** — ${tp.description}`).join("\n");
  return new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(p.title || "🎫 Support Tickets")
    .setDescription(`${p.description || ""}\n\n${lines}`)
    .setFooter({ text: p.footer || config.brand?.footer || "D7 Dev" });
}

// ─────────── أدوات ───────────
function canManage(member, guildId) {
  if (!member) return false;
  const t = ensureConfig();
  if ((t.staffRoles || []).some(r => member.roles.cache.has(r))) return true;
  if (member.permissions.has("ManageChannels")) return true;
  return false;
}

async function makeTranscript(channel) {
  const all = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all.map(m => {
    const time = new Date(m.createdTimestamp).toISOString();
    const files = [...m.attachments.values()].map(a => a.url).join(" ");
    const embeds = m.embeds.map(e => `[Embed: ${e.title || ""} ${e.description || ""}]`).join(" ");
    return `[${time}] ${m.author?.tag || "Unknown"}: ${m.content || ""} ${files} ${embeds}`.trim();
  }).join("\n");
}

function logChannel(guild) {
  const id = ensureConfig().logChannelId;
  return safeChannelId(id) ? guild.channels.cache.get(id) : null;
}

// ─────────── فتح تذكرة ───────────
async function handleSelect(interaction) {
  const typeId = interaction.values[0];
  const t = ensureConfig();
  const type = types().find(x => x.id === typeId);
  if (!type || type.enabled === false) {
    return interaction.reply({ content: "❌ هذا النوع معطّل حالياً من إعدادات التذاكر. انتظر إعادة إرسال اللوحة.", ephemeral: true });
  }

  // إعادة ضبط القائمة في اللوحة (حتى لو فشل الفتح)
  try { await interaction.message.edit({ components: panelRows() }); } catch {}

  const existing = db.tickets.getUserOpen(interaction.user.id, interaction.guild.id);
  if (existing.length) {
    return interaction.reply({ content: `⚠️ لديك تذكرة مفتوحة بالفعل: <#${existing[0].channel_id}>\nأغلقها أولاً قبل فتح تذكرة جديدة.`, ephemeral: true });
  }

  try {
    const number = db.tickets.nextNumber(interaction.guild.id);
    const category = safeChannelId(t.categoryId) ? interaction.guild.channels.cache.get(t.categoryId) : null;
    const channel = await interaction.guild.channels.create({
      name: `${type.emoji || "🎫"} ticket-${number}`,
      type: ChannelType.GuildText,
      parent: category || undefined,
      topic: `D7 ticket #${number} | ${type.label} | User ${interaction.user.id}`,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: ["ViewChannel"] },
        { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles"] },
        ...(t.staffRoles || []).filter(safeChannelId).map(id => ({ id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] })),
      ],
    });
    db.tickets.create({ channelId: channel.id, guildId: interaction.guild.id, userId: interaction.user.id, type: typeId, number });

    const controlEmbed = new EmbedBuilder()
      .setColor(type.color || TICKET_COLOR)
      .setTitle(`${type.emoji || "🎫"} ${type.label} #${number}`)
      .setDescription(`Welcome <@${interaction.user.id}>!\nPlease describe your issue and our staff will assist you shortly.`)
      .setFooter({ text: config.brand?.footer || "D7 Dev" })
      .setTimestamp();
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d7_tk_claim").setLabel("📥 Claim").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("d7_tk_summon").setLabel("📣 Summon").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("d7_tk_close").setLabel("🔒 Close Ticket").setStyle(ButtonStyle.Danger),
    );
    await channel.send({ content: `<@${interaction.user.id}>`, embeds: [controlEmbed], components: [controlRow] });
    await sendLog(interaction.guild, embed("🎫 تذكرة جديدة", `**#${number}** • ${type.label}\nالعميل: <@${interaction.user.id}>\nالروم: ${channel}`));
    await interaction.reply({ content: `✅ تم فتح تذكرتك: ${channel}`, ephemeral: true });
  } catch (err) {
    console.error("Ticket create failed:", err);
    await interaction.reply({
      content: `❌ تعذر فتح التذكرة.\nتأكد أن البوت له صلاحية **إنشاء الرومات** وصلاحية الوصول للكاتيجوري.\n\`${err.message}\``,
      ephemeral: true,
    });
  }
}

async function sendLog(guild, e) {
  const ch = logChannel(guild);
  if (ch?.isTextBased()) await ch.send({ embeds: [e] }).catch(() => {});
}

// ─────────── الاستلام ───────────
async function handleClaim(interaction) {
  const ticket = db.tickets.get(interaction.channel.id);
  if (!ticket || ticket.status === "closed") return interaction.reply({ content: "❌ هذه ليست تذكرة نشطة.", ephemeral: true });
  if (!canManage(interaction.member, interaction.guild.id)) return interaction.reply({ content: "❌ فقط فريق الدعم يمكنه الاستلام.", ephemeral: true });
  db.tickets.claim(interaction.channel.id, interaction.user.id);
  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({
      embeds: [embed("📥 Your ticket has been claimed!", `Your ticket **#${ticket.number}** has been claimed by the support team.\nتم استلام تذكرتك **رقم ${ticket.number}** من قبل فريق الدعم.\n\n<@${interaction.user.id}>`)],
    }).catch(() => {});
  }
  await interaction.channel.send({ content: `📥 تم استلام التذكرة بواسطة <@${interaction.user.id}>` }).catch(() => {});
  await interaction.reply({ content: "✅ تم استلام التذكرة! أُرسل إشعار لصاحبها.", ephemeral: true });
  await sendLog(interaction.guild, embed("📥 تذكرة مستلمة", `**#${ticket.number}**\nالعميل: <@${ticket.user_id}>\nال.staff: ${interaction.user}`));
}

// ─────────── الاستدعاء ───────────
async function handleSummon(interaction) {
  const ticket = db.tickets.get(interaction.channel.id);
  if (!ticket || ticket.status === "closed") return interaction.reply({ content: "❌ هذه ليست تذكرة نشطة.", ephemeral: true });
  if (!canManage(interaction.member, interaction.guild.id)) return interaction.reply({ content: "❌ فقط فريق الدعم يمكنه استدعاء صاحب التذكرة.", ephemeral: true });
  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    const link = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;
    await user.send({ embeds: [embed("📣 Please reply to your ticket!", `Please reply to your ticket **#${ticket.number}**.\nالرجاء الرد على تذكرتك **رقم ${ticket.number}**.\n\n${link}`)] }).catch(() => {});
  }
  await interaction.channel.send({ content: `📣 تم استدعاء صاحب التذكرة بواسطة <@${interaction.user.id}>` }).catch(() => {});
  await interaction.reply({ content: "✅ تم استدعاء صاحب التذكرة (إشعار على الخاص).", ephemeral: true });
}

// ─────────── الإغلاق ───────────
async function handleClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  const ticket = db.tickets.get(channel.id);
  if (!ticket || ticket.status === "closed") return interaction.reply({ content: "❌ هذه ليست تذكرة نشطة.", ephemeral: true });

  // المالك أو فريق الدعم
  if (interaction.user.id !== ticket.user_id && !canManage(interaction.member, guild.id)) {
    return interaction.reply({ content: "❌ فقط صاحب التذكرة أو فريق الدعم يمكنه الإغلاق.", ephemeral: true });
  }

  db.tickets.close(channel.id, interaction.user.id);
  await interaction.reply({ content: "🔒 جاري إغلاق التذكرة وحفظ السجل..." });

  const transcript = await makeTranscript(channel).catch(() => "");
  const fileName = `${cleanFileName(`ticket-${ticket.number}`)}.txt`;
  const file = new AttachmentBuilder(Buffer.from(transcript || "No messages captured.", "utf8"), { name: fileName });

  const ch = logChannel(guild);
  if (ch?.isTextBased()) {
    await ch.send({
      embeds: [new EmbedBuilder().setTitle("🔒 Ticket Closed").setColor("Red").addFields(
        { name: "المستخدم", value: `<@${ticket.user_id}>` },
        { name: "أغلقها", value: `<@${interaction.user.id}>` },
        { name: "النوع", value: ticket.type }
      ).setTimestamp()],
      files: [file],
    }).catch(() => {});
  }

  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({
      embeds: [new EmbedBuilder().setColor("Red").setTitle("🔒 Your ticket has been closed")
        .setDescription(`Your ticket **#${ticket.number}** has been closed. If you need more help, feel free to open a new ticket!\nتم قفل تذكرتك **رقم ${ticket.number}**، إذا كنت بحاجة لأي مساعدة يمكنك فتح تذكرة جديدة.`)
        .setFooter({ text: config.brand?.footer || "D7 Dev" })
        .setTimestamp()],
      files: [file],
    }).catch(() => {});
  }

  setTimeout(() => channel.delete("Ticket closed").catch(() => {}), 5000);
}

module.exports = {
  ensureConfig, saveConfig, types, panelRows, panelEmbed,
  handleSelect, handleClaim, handleSummon, handleClose, canManage, DEFAULT_TYPES,
};
