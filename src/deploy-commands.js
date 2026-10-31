require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder().setName("panel").setDescription("Open the unified S2A DEV control panel"),
  // /panel2 — اللوحة نفسها لكن غير خاصة: تُنشر في الروم ويراه الجميع ويبقى
  // ثابتة كأي رسالة، بدل /panel التي تظهر لصاحب الأمر فقط وتختفي معه
  new SlashCommandBuilder().setName("panel2").setDescription("Post the public control panel here - visible to everyone"),
  new SlashCommandBuilder().setName("ticket-panel").setDescription("Post the S2A DEV ticket panel"),
  new SlashCommandBuilder().setName("products").setDescription("List products"),
  new SlashCommandBuilder().setName("product-add").setDescription("Add a store product (role → price → name)")
    .addStringOption(o=>o.setName("name").setDescription("Product name (skip the name step)").setRequired(false))
    .addNumberOption(o=>o.setName("price").setDescription("Price in SAR (skip the price step)").setRequired(false).setMinValue(0)),
  new SlashCommandBuilder().setName("rate").setDescription("إرسال رسالة تقييم منتج لعميل على الخاص")
    .addUserOption(o=>o.setName("user").setDescription("العميل الذي سيُقيّم").setRequired(true))
    .addStringOption(o=>o.setName("product").setDescription("اسم المنتج (اكتب أو اختر من القائمة)").setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName("product-edit").setDescription("Change product availability")
    .addIntegerOption(o=>o.setName("id").setDescription("Product ID").setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName("status").setDescription("New status").setRequired(true)
      .addChoices({name:"Working",value:"working"},{name:"Maintenance",value:"maintenance"},{name:"Stopped",value:"stopped"})),
  new SlashCommandBuilder().setName("product-panel").setDescription("Publish product cards to configured showcase channel"),
  new SlashCommandBuilder().setName("order-create").setDescription("Create a manual order")
    .addUserOption(o=>o.setName("customer").setDescription("Customer").setRequired(true))
    .addIntegerOption(o=>o.setName("product_id").setDescription("Product ID").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("order-confirm").setDescription("Confirm payment and grant product role")
    .addIntegerOption(o=>o.setName("order_id").setDescription("Order ID").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("order-deliver").setDescription("Mark an order as delivered")
    .addIntegerOption(o=>o.setName("order_id").setDescription("Order ID").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("order-cancel").setDescription("Cancel an order and post the status to the order log")
    .addIntegerOption(o=>o.setName("order_id").setDescription("Order ID").setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName("reason").setDescription("Reason shown on the log entry").setRequired(false)),
  new SlashCommandBuilder().setName("orders").setDescription("Show recent orders"),
  new SlashCommandBuilder().setName("dashboard-refresh").setDescription("Refresh admin dashboard"),
  new SlashCommandBuilder().setName("embed-send").setDescription("Send a custom embed")
    .addChannelOption(o=>o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement))
    .addStringOption(o=>o.setName("title").setDescription("Embed title").setRequired(true))
    .addStringOption(o=>o.setName("description").setDescription("Embed description").setRequired(true))
    .addStringOption(o=>o.setName("image").setDescription("Image URL")),
  new SlashCommandBuilder().setName("post-message").setDescription("Post news, rules or update")
    .addStringOption(o=>o.setName("kind").setDescription("Message type").setRequired(true).addChoices({name:"News",value:"news"},{name:"Rules",value:"rules"},{name:"Update",value:"update"}))
    .addStringOption(o=>o.setName("title").setDescription("Title").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Message body").setRequired(true))
    .addStringOption(o=>o.setName("image").setDescription("Image URL")),
  new SlashCommandBuilder().setName("stats").setDescription("Product sales and rating statistics"),
  new SlashCommandBuilder().setName("close").setDescription("قفل الروم اللي كتبت فيه الأمر (يمنع الإرسال والثريدات)"),
  new SlashCommandBuilder().setName("open").setDescription("فتح الروم اللي كتبت فيه الأمر (يرجع الصلاحيات للوضع الطبيعي)"),
  new SlashCommandBuilder().setName("welcome-set").setDescription("Set welcome text and image")
    .addStringOption(o=>o.setName("message").setDescription("Use {user} and {server}").setRequired(true))
    .addStringOption(o=>o.setName("image").setDescription("Image URL"))
].map(c => c.setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON());

async function main() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    throw new Error("Set DISCORD_TOKEN, CLIENT_ID and GUILD_ID in .env first.");
  }
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log(`Deployed ${commands.length} S2A DEV slash commands.`);
}
main().catch(e => { console.error(e); process.exit(1); });
