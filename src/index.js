require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, RoleSelectMenuBuilder,
  ChannelType, PermissionFlagsBits
} = require("discord.js");
const db = require("./db");
const { embed, hasStaff, formatPrice, safeChannelId, cleanFileName } = require("./utils");
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
  const openTickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status IN ('open','claimed')").get().n;
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

async function createTicket(interaction, topic) {
  const guild = interaction.guild;
  const existing = db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status IN ('open','claimed')").get(guild.id, interaction.user.id);
  if (existing) {
    return interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, ephemeral: true });
  }
  const categoryId = config.tickets?.categoryId;
  const channel = await guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 90),
    type: ChannelType.GuildText,
    parent: safeChannelId(categoryId) ? categoryId : undefined,
    topic: `D7 ticket | User ${interaction.user.id} | Topic ${topic}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...[...(config.roles.staff || []), ...(config.roles.admin || [])].filter(safeChannelId).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
    ]
  });
  const result = db.prepare("INSERT INTO tickets (guild_id,channel_id,user_id,topic) VALUES (?,?,?,?)").run(guild.id, channel.id, interaction.user.id, topic);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim:${result.lastInsertRowid}`).setLabel("Claim ticket").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_call:${result.lastInsertRowid}`).setLabel("Call customer").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_close:${result.lastInsertRowid}`).setLabel("Close ticket").setStyle(ButtonStyle.Danger)
  );
  await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed(`Ticket #${result.lastInsertRowid}`, `**Topic:** ${topic}\nDescribe what you need help with. Staff can claim this ticket below.`)], components: [row] });
  await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  await sendToConfiguredChannel(guild, "ticketLogs", { embeds: [embed("Ticket opened", `Ticket: ${channel}\nCustomer: <@${interaction.user.id}>\nTopic: ${topic}`)] });
  await refreshAdminDashboard(guild);
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
    const text = m.content || "";
    const files = [...m.attachments.values()].map(a => a.url).join(" ");
    const embeds = m.embeds.map(e => `[Embed: ${e.title || ""} ${e.description || ""}]`).join(" ");
    return `[${time}] ${m.author?.tag || "Unknown"} (${m.author?.id || "?"}): ${text} ${files} ${embeds}`.trim();
  }).join("\n");
}

async function closeTicket(interaction, ticketId) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(ticketId);
  if (!ticket || ticket.status === "closed") return interaction.reply({ content: "This ticket is already closed.", ephemeral: true });
  if (!hasStaff(interaction.member) && interaction.user.id !== ticket.user_id) {
    return interaction.reply({ content: "Only the ticket owner or staff can close this ticket.", ephemeral: true });
  }
  await interaction.reply({ content: "Closing ticket and preparing transcript…", ephemeral: true });
  const transcript = await makeTranscript(interaction.channel);
  const fileName = `${cleanFileName(`ticket-${ticketId}`)}.txt`;
  const attachment = new AttachmentBuilder(Buffer.from(transcript || "No messages captured.", "utf8"), { name: fileName });
  await sendToConfiguredChannel(interaction.guild, "ticketTranscripts", { content: `Transcript for ticket #${ticketId} — customer <@${ticket.user_id}>`, files: [attachment] });
  const user = await client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({ content: `Your D7 Dev ticket #${ticketId} has been closed. Here is the conversation transcript.`, files: [new AttachmentBuilder(Buffer.from(transcript || "No messages captured.", "utf8"), { name: fileName })] }).catch(() => {});
    if (config.tickets?.closeRatingEnabled) {
      const row = new ActionRowBuilder().addComponents(
        ...[1,2,3,4,5].map(n => new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:${n}`).setLabel(`${n} ★`).setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary))
      );
      await user.send({ content: `Please rate your support experience for ticket #${ticketId}.`, components: [row] }).catch(() => {});
    }
  }
  db.prepare("UPDATE tickets SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(ticketId);
  await sendToConfiguredChannel(interaction.guild, "ticketLogs", { embeds: [embed("Ticket closed", `Ticket #${ticketId}\nCustomer: <@${ticket.user_id}>\nClosed by: ${interaction.user}`)] });
  if (config.tickets?.deleteAfterClose) setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  await refreshAdminDashboard(interaction.guild);
}

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
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === "panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("panel:products").setLabel("Products").setEmoji("🛍️").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("panel:orders").setLabel("Orders").setEmoji("🧾").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("panel:tickets").setLabel("Tickets").setEmoji("🎫").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("panel:content").setLabel("Messages & Embeds").setEmoji("📝").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("panel:analytics").setLabel("Analytics").setEmoji("📊").setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("panel:welcome").setLabel("Welcome Settings").setEmoji("👋").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Dashboard").setEmoji("🔄").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("panel:autoroles").setLabel("Automatic Roles").setEmoji("🏷️").setStyle(ButtonStyle.Secondary)
        );
        const e = embed("D7 Dev • Control Center", "Manage the store and server from this panel. Choose a section below.\n\n**Products:** add items, update status and publish showcase.\n**Orders:** review requests, confirm payments and mark delivery.\n**Tickets:** publish the ticket panel and manage support.\n**Messages:** send news, rules, updates and custom embeds.\n**Analytics:** sales, ratings and top products.\n\nOnly staff with configured staff/admin roles can use this panel.");
        return interaction.reply({ embeds: [e], components: [row1, row2], ephemeral: true });
      }
      if (commandName === "ticket-panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_open:Support").setLabel("Support").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("ticket_open:Purchase").setLabel("Purchase").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("ticket_open:Technical").setLabel("Technical").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ embeds: [embed("D7 Dev Support", "Choose a ticket category below.")], components: [row] });
      }
      if (commandName === "products") {
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        if (!products.length) return interaction.reply({ content: "No products added yet.", ephemeral: true });
        return interaction.reply({ embeds: products.slice(0, 10).map(productEmbed), ephemeral: true });
      }
      if (commandName === "product-add") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const name = interaction.options.getString("name", true);
        const price = interaction.options.getNumber("price", true);
        const description = interaction.options.getString("description") || "";
        const roleId = interaction.options.getRole("role")?.id || "";
        const imageUrl = interaction.options.getString("image") || "";
        const downloadUrl = interaction.options.getString("download") || "";
        const res = db.prepare("INSERT INTO products (name,price,description,role_id,image_url,download_url) VALUES (?,?,?,?,?,?)").run(name, price, description, roleId, imageUrl, downloadUrl);
        return interaction.reply({ content: `Product **${name}** created with ID \`${res.lastInsertRowid}\`.`, ephemeral: true });
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
        await interaction.reply({ content: `Publishing ${Math.min(products.length, 10)} product(s)…`, ephemeral: true });
        for (const product of products.slice(0, 10)) {
          await sendToConfiguredChannel(interaction.guild, "productShowcase", { embeds: [productEmbed(product)], components: productPanelRows(product.id) });
        }
        return;
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
        const id = interaction.options.getInteger("order_id", true);
        const order = db.prepare("SELECT o.*, p.name, p.role_id, p.price, p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?").get(id);
        if (!order) return interaction.reply({ content: "Order not found.", ephemeral: true });
        const guild = interaction.guild;
        const member = await guild.members.fetch(order.user_id).catch(() => null);
        if (!member) return interaction.reply({ content: "Customer is not a member of this server.", ephemeral: true });
        if (order.role_id) await member.roles.add(order.role_id, `D7 Dev order #${id} confirmed`);
        db.prepare("UPDATE orders SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,confirmed_by=? WHERE id=?").run(interaction.user.id, id);
        if (config.purchase.sendThankYouDM) {
          await member.send({ embeds: [embed("Thank you for your purchase!", `Your purchase of **${order.name}** has been confirmed.\nOrder: #${id}\nProduct role: ${order.role_id ? `<@&${order.role_id}>` : "No role configured"}`)] }).catch(() => {});
        }
        if (config.purchase.sendProductReviewDM) {
          const row = new ActionRowBuilder().addComponents(...[1,2,3,4,5].map(n => new ButtonBuilder().setCustomId(`product_rate:${id}:${n}`).setLabel(`${n} ★`).setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)));
          await member.send({ content: `Please rate **${order.name}** (Order #${id}).`, components: [row] }).catch(() => {});
        }
        await sendToConfiguredChannel(guild, "orders", { embeds: [embed("Order confirmed", `Order #${id}\nCustomer: <@${order.user_id}>\nProduct: **${order.name}**\nPrice: ${formatPrice(order.price, order.currency)}\nConfirmed by: ${interaction.user}`)] });
        await refreshAdminDashboard(guild);
        return interaction.reply({ content: `Order #${id} confirmed. Product role assigned if configured.`, ephemeral: true });
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
        const productStats = db.prepare(`SELECT p.name,COUNT(o.id) count,COALESCE(AVG(o.rating),0) avg FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.status IN ('confirmed','delivered') GROUP BY p.id ORDER BY count DESC`).all();
        const desc = productStats.length ? productStats.map(p => `**${p.name}** — ${p.count} purchase(s) • ${(p.avg || 0).toFixed(1)}/5`).join("\n") : "No products yet.";
        return interaction.reply({ embeds: [embed("Product Analytics", desc)], ephemeral: true });
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
      const roleId = interaction.values[0];
      if (target === "member") config.autoRoles.memberRoleId = roleId;
      else if (target === "bot") config.autoRoles.botRoleId = roleId;
      fs.writeFileSync(path.join(__dirname, "..", "config.json"), JSON.stringify(config, null, 2));
      return interaction.reply({ content: `Automatic ${target === "member" ? "member" : "bot"} role saved: <@&${roleId}>. Open /panel → Automatic Roles to enable it if needed.`, ephemeral: true });
    }

    if (interaction.isButton()) {
      const [action, ...parts] = interaction.customId.split(":");
      if (action === "panel") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const section = parts[0];
        if (section === "products") {
          const products = db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 10").all();
          const list = products.length ? products.map(p => `**#${p.id} — ${p.name}** · ${formatPrice(p.price,p.currency)} · ${p.status}`).join("\n") : "No products yet.";
          const rows = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel:add-product").setLabel("Add Product").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("panel:publish-products").setLabel("Publish Showcase").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("panel:products-list").setLabel("Refresh List").setStyle(ButtonStyle.Secondary)
          )];
          return interaction.update({ embeds: [embed("Control Center · Products", `${list}\n\nUse Add Product to create a product, or Publish Showcase to publish the product cards.`)], components: rows });
        }
        if (section === "add-product") {
          const modal = new ModalBuilder().setCustomId("panel_modal:add-product").setTitle("Add Store Product");
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Product name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Price in SAR").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("description").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role").setLabel("Product role ID (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300))
          );
          return interaction.showModal(modal);
        }
        if (section === "publish-products") {
          const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
          if (!products.length) return interaction.reply({ content: "Add products first from the Products section.", ephemeral: true });
          let sent = 0;
          for (const product of products.slice(0, 10)) if (await sendToConfiguredChannel(interaction.guild, "productShowcase", { embeds: [productEmbed(product)], components: productPanelRows(product.id) })) sent++;
          return interaction.reply({ content: `Published ${sent} product card(s). Check the productShowcase channel ID in config.json if none were sent.`, ephemeral: true });
        }
        if (section === "products-list") {
          const products = db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 10").all();
          return interaction.update({ embeds: [embed("Control Center · Products", products.length ? products.map(p => `**#${p.id} — ${p.name}** · ${formatPrice(p.price,p.currency)} · ${p.status}`).join("\n") : "No products yet.")], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:add-product").setLabel("Add Product").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("panel:publish-products").setLabel("Publish Showcase").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:products-list").setLabel("Refresh List").setStyle(ButtonStyle.Secondary))] });
        }
        if (section === "orders") {
          const rows = db.prepare(`SELECT o.*,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 10`).all();
          const desc = rows.length ? rows.map(o => `**#${o.id} — ${o.product_name}** · <@${o.user_id}> · ${o.status} · ${formatPrice(o.price,o.currency)}\nRating: ${o.rating ? `${o.rating}/5` : "Not rated"}`).join("\n\n") : "No orders yet.";
          return interaction.update({ embeds: [embed("Control Center · Orders", `${desc}\n\nConfirm payments or mark orders delivered using the order commands.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:orders-pending").setLabel("Pending Orders").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("panel:orders").setLabel("Refresh").setStyle(ButtonStyle.Primary))] });
        }
        if (section === "orders-pending") {
          const rows = db.prepare(`SELECT o.id,o.user_id,p.name product_name,p.price,p.currency FROM orders o JOIN products p ON p.id=o.product_id WHERE o.status='pending' ORDER BY o.id DESC LIMIT 10`).all();
          const desc = rows.length ? rows.map(o => `**#${o.id} — ${o.product_name}** · <@${o.user_id}> · ${formatPrice(o.price,o.currency)}`).join("\n") : "No pending orders.";
          return interaction.update({ embeds: [embed("Pending Orders", `${desc}\n\nUse /order-confirm with the order ID after checking payment.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:orders").setLabel("All Orders").setStyle(ButtonStyle.Primary))] });
        }
        if (section === "tickets") {
          const open = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status IN ('open','claimed')").get().n;
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:publish-tickets").setLabel("Publish Ticket Panel").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:ticket-stats").setLabel("Open Ticket Count").setStyle(ButtonStyle.Secondary));
          return interaction.update({ embeds: [embed("Control Center · Tickets", `Currently open/claimed tickets: **${open}**\nUse Publish Ticket Panel to post the customer-facing ticket menu in this channel. Ticket claim/call/close controls are inside each ticket.`)], components: [row] });
        }
        if (section === "publish-tickets") {
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket_open:Support").setLabel("Support").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("ticket_open:Purchase").setLabel("Purchase").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("ticket_open:Technical").setLabel("Technical").setStyle(ButtonStyle.Secondary));
          return interaction.reply({ embeds: [embed("D7 Dev Support", "Choose a ticket category below.")], components: [row], ephemeral: false });
        }
        if (section === "ticket-stats") return interaction.reply({ content: `Open/claimed tickets: ${db.prepare("SELECT COUNT(*) n FROM tickets WHERE status IN ('open','claimed')").get().n}`, ephemeral: true });
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
          const productStats = db.prepare(`SELECT p.name,COUNT(o.id) count,COALESCE(AVG(o.rating),0) avg FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.status IN ('confirmed','delivered') GROUP BY p.id ORDER BY count DESC`).all();
          const desc = productStats.length ? productStats.map(p => `**${p.name}** — ${p.count} purchase(s) · ${(p.avg || 0).toFixed(1)}/5`).join("\n") : "No products yet.";
          return interaction.update({ embeds: [embed("Control Center · Analytics", desc)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Admin Dashboard").setStyle(ButtonStyle.Success))] });
        }
        if (section === "welcome") {
          const modal = new ModalBuilder().setCustomId("panel_modal:welcome").setTitle("Welcome Settings");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("body").setLabel("Welcome text ({user}, {server})").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Direct image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
          return interaction.showModal(modal);
        }
        if (section === "autoroles") {
          config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
          const enabledText = config.autoRoles.enabled ? "ENABLED" : "DISABLED";
          const memberRole = config.autoRoles.memberRoleId ? `<@&${config.autoRoles.memberRoleId}>` : "Not set";
          const botRole = config.autoRoles.botRoleId ? `<@&${config.autoRoles.botRoleId}>` : "Not set";
          const rows = [
            new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("autorole_select:member").setPlaceholder("Choose automatic role for members").setMinValues(1).setMaxValues(1)),
            new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("autorole_select:bot").setPlaceholder("Choose automatic role for bots").setMinValues(1).setMaxValues(1)),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("panel:autoroles-toggle").setLabel(config.autoRoles.enabled ? "Disable Auto Roles" : "Enable Auto Roles").setStyle(config.autoRoles.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
              new ButtonBuilder().setCustomId("panel:home").setLabel("Back to Main Panel").setStyle(ButtonStyle.Secondary)
            )
          ];
          return interaction.update({ embeds: [embed("Automatic Role Settings", `Status: **${enabledText}**\nMember role: ${memberRole}\nBot role: ${botRole}\n\nChoose roles using the menus, then enable automatic roles. Existing members are not changed; this applies when someone joins. The bot must have Manage Roles and its highest role must be above the roles you select.`)], components: rows });
        }
        if (section === "autoroles-toggle") {
          config.autoRoles ||= { enabled: false, memberRoleId: "", botRoleId: "" };
          config.autoRoles.enabled = !config.autoRoles.enabled;
          fs.writeFileSync(path.join(__dirname, "..", "config.json"), JSON.stringify(config, null, 2));
          const enabledText = config.autoRoles.enabled ? "ENABLED" : "DISABLED";
          const rows = [
            new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("autorole_select:member").setPlaceholder("Choose automatic role for members").setMinValues(1).setMaxValues(1)),
            new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("autorole_select:bot").setPlaceholder("Choose automatic role for bots").setMinValues(1).setMaxValues(1)),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:autoroles-toggle").setLabel(config.autoRoles.enabled ? "Disable Auto Roles" : "Enable Auto Roles").setStyle(config.autoRoles.enabled ? ButtonStyle.Danger : ButtonStyle.Success),new ButtonBuilder().setCustomId("panel:home").setLabel("Back to Main Panel").setStyle(ButtonStyle.Secondary))
          ];
          return interaction.update({ embeds: [embed("Automatic Role Settings", `Automatic roles are now **${enabledText}**.\nMember role: ${config.autoRoles.memberRoleId ? `<@&${config.autoRoles.memberRoleId}>` : "Not set"}\nBot role: ${config.autoRoles.botRoleId ? `<@&${config.autoRoles.botRoleId}>` : "Not set"}`)], components: rows });
        }
        if (section === "home") {
          const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:products").setLabel("Products").setEmoji("🛍️").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:orders").setLabel("Orders").setEmoji("🧾").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:tickets").setLabel("Tickets").setEmoji("🎫").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel:content").setLabel("Messages & Embeds").setEmoji("📝").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("panel:analytics").setLabel("Analytics").setEmoji("📊").setStyle(ButtonStyle.Secondary));
          const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel:welcome").setLabel("Welcome Settings").setEmoji("👋").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("panel:refresh").setLabel("Refresh Dashboard").setEmoji("🔄").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("panel:autoroles").setLabel("Automatic Roles").setEmoji("🏷️").setStyle(ButtonStyle.Secondary));
          return interaction.update({ embeds: [embed("D7 Dev • Control Center", "Manage products, orders, tickets, messages, analytics, welcome settings and automatic join roles from here.")], components: [row1,row2] });
        }
        if (section === "refresh") {
          await refreshAdminDashboard(interaction.guild);
          return interaction.reply({ content: "Admin dashboard refreshed where configured.", ephemeral: true });
        }
      }
      if (action === "ticket_open") return createTicket(interaction, parts.join(":"));
      if (action === "ticket_claim") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const id = Number(parts[0]);
        const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
        if (!ticket || ticket.status === "closed") return interaction.reply({ content: "Ticket not active.", ephemeral: true });
        if (config.tickets?.staffCanClaimOnlyOne) {
          const other = db.prepare("SELECT id FROM tickets WHERE claimed_by=? AND status='claimed' AND id<>?").get(interaction.user.id, id);
          if (other) return interaction.reply({ content: `You already claimed ticket #${other.id}. Close or unclaim it first.`, ephemeral: true });
        }
        db.prepare("UPDATE tickets SET status='claimed',claimed_by=?,claimed_at=CURRENT_TIMESTAMP WHERE id=?").run(interaction.user.id, id);
        await interaction.reply({ embeds: [embed("Ticket claimed", `Claimed by ${interaction.user}.`)] });
        await sendToConfiguredChannel(interaction.guild, "ticketLogs", { embeds: [embed("Ticket claimed", `Ticket #${id}\nStaff: ${interaction.user}`)] });
        return;
      }
      if (action === "ticket_call") {
        if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
        const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(Number(parts[0]));
        if (!ticket) return interaction.reply({ content: "Ticket not found.", ephemeral: true });
        const user = await client.users.fetch(ticket.user_id).catch(() => null);
        if (user) await user.send(`A staff member is waiting for you in your D7 Dev ticket: <#${ticket.channel_id}>`).catch(() => {});
        return interaction.reply({ content: "Customer has been called by DM if their DMs are open.", ephemeral: true });
      }
      if (action === "ticket_close") return closeTicket(interaction, Number(parts[0]));
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
        await sendToConfiguredChannel(interaction.guild, "salesLogs", { embeds: [embed("New purchase request", `Order #${result.lastInsertRowid}\nCustomer: ${interaction.user}\nProduct: **${p.name}**\nPrice: ${formatPrice(p.price,p.currency)}\nConfirm using /order-confirm order_id:${result.lastInsertRowid}`)] });
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
      if (action === "ticket_rate") {
        const ticketId = Number(parts[0]), rating = Number(parts[1]);
        const ticket = db.prepare("SELECT * FROM tickets WHERE id=? AND user_id=? AND status='closed'").get(ticketId, interaction.user.id);
        if (!ticket) return interaction.reply({ content: "Ticket not found or not closed.", ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`review_modal:ticket:${ticketId}:${rating}`).setTitle("Rate support");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("review").setLabel("Your review (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("panel_modal:")) {
      if (!hasStaff(interaction.member)) return interaction.reply({ content: "Staff only.", ephemeral: true });
      const kind = interaction.customId.split(":")[1];
      if (kind === "add-product") {
        const name = interaction.fields.getTextInputValue("name").trim();
        const price = Number(interaction.fields.getTextInputValue("price").replace(/,/g, ""));
        const description = interaction.fields.getTextInputValue("description") || "";
        const roleId = (interaction.fields.getTextInputValue("role") || "").trim();
        const imageUrl = (interaction.fields.getTextInputValue("image") || "").trim();
        if (!Number.isFinite(price) || price < 0) return interaction.reply({ content: "Price must be a valid number, e.g. 150 or 150.50.", ephemeral: true });
        if (roleId && !/^\d{17,20}$/.test(roleId)) return interaction.reply({ content: "Role ID is invalid. Leave it blank or enter the role ID.", ephemeral: true });
        if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return interaction.reply({ content: "Image must be a direct http/https URL.", ephemeral: true });
        const res = db.prepare("INSERT INTO products (name,price,description,role_id,image_url) VALUES (?,?,?,?,?)").run(name, price, description, roleId, imageUrl);
        return interaction.reply({ content: `Product **${name}** added successfully. ID: #${res.lastInsertRowid}.`, ephemeral: true });
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
      if (type === "ticket") {
        const ticket = db.prepare("SELECT * FROM tickets WHERE id=? AND user_id=?").get(id, interaction.user.id);
        if (!ticket) return interaction.reply({ content: "Ticket not found.", ephemeral: true });
        db.prepare("UPDATE tickets SET rating=?,review=? WHERE id=?").run(rating, review, id);
        db.prepare("INSERT INTO ticket_ratings (ticket_id,user_id,rating,review) VALUES (?,?,?,?)").run(id, interaction.user.id, rating, review);
        await sendToConfiguredChannel(interaction.guild, "reviews", { embeds: [embed("Support review", `Ticket: #${id}\nCustomer: <@${interaction.user.id}>\nRating: ${rating}/5\nReview: ${review || "No written comment."}`)] });
        return interaction.reply({ content: "Thank you for rating D7 Dev support.", ephemeral: true });
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
