// ═══════════════ نظام التقييمات — نسخة طبق الأصل من NSR Hub ═══════════════
// نفس النصوص ونفس النظام بالضبط:
// خاص "Thank you for purchase" → نجوم ⭐ 1-5 → اختيار اللغة → نافذة الرسالة → روم التقييمات (Feedback)
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const { EMBED_COLOR, EMBED_THUMB } = require("./utils");
const config = require("../config.json");

const CONFIG_FILE = path.join(__dirname, "..", "config.json");
const STARS_FULL = ["", "⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"];

function ratingCfg() {
  config.channels ||= {};
  return config.channels;
}

function saveRatingConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.warn("فشل حفظ إعدادات التقييمات: " + err.message);
  }
}

// ═══════════════ المنتجات ═══════════════
function getProducts() {
  // price/currency يلزمون لعرض السعر في رسالة تأكيد الشراء
  return db.prepare("SELECT id, name, role_id, price, currency FROM products ORDER BY id DESC").all()
    .map(p => ({ id: String(p.id), name: p.name, roleId: p.role_id || "", price: p.price, currency: p.currency || "SAR" }));
}

function findProduct(_guildId, idOrName) {
  const products = getProducts();
  return products.find(p => p.id === String(idOrName)) ||
    products.find(p => p.name.toLowerCase() === String(idOrName).toLowerCase());
}

// البحث بالرتبة: نستخدمه لإرسال رسالة التقييم تلقائياً لمجرد حصول العضو على رتبة منتج
function getByRole(roleId) {
  if (!roleId) return null;
  return getProducts().find(p => p.roleId && p.roleId === String(roleId)) || null;
}

// ═══════════════ إرسال رسالة الشراء على الخاص ═══════════════
async function sendPurchaseDM(target, product, client, guild) {
  try {
    const dm = await target.createDM();
    const e = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setThumbnail(EMBED_THUMB)
      .setTitle("Thank you for purchase")
      .setDescription(`\n**Products**\n**${product.name}**\n\nشكراً لثقتك بنا 💙\nنتمنى أن تكون تجربتك معنا رائعة.\nقيّم تجربتك بالأسفل ⭐`);
    const starRow = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map(s => new ButtonBuilder()
        .setCustomId(`rate_star_${s}_${guild?.id || "0"}_${product.id}_ar`)
        .setLabel("⭐".repeat(s))
        .setStyle(ButtonStyle.Secondary))
    );
    const langRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rate_lang_${guild?.id || "0"}_ar_${product.id}`).setLabel("العربية 🇸🇦").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rate_lang_${guild?.id || "0"}_en_${product.id}`).setLabel("English 🇬🇧").setStyle(ButtonStyle.Secondary),
    );
    await dm.send({ embeds: [e], components: [starRow, langRow] });
    return true;
  } catch (err) {
    console.warn("تعذر إرسال خاص: " + err.message);
    return false;
  }
}

// ═══════════════ اختيار اللغة (تحديث الرسالة مع النجوم) ═══════════════
async function handleLangButton(interaction) {
  const parts = interaction.customId.split("_"); // rate_lang_<guildId>_<lang>_<pid>
  const guildId = parts[2];
  const lang = parts[3];
  const pid = parts.slice(4).join("_");
  const product = findProduct(guildId, pid);
  if (!product) {
    await interaction.reply({ content: "❌ المنتج لم يعد موجوداً.", ephemeral: true });
    return;
  }
  const ar = lang === "ar";
  const desc = ar
    ? ["**Products**", `**${product.name}**`, "", "شكراً لثقتك بنا 💙", "نتمنى أن تكون تجربتك معنا رائعة.", "قيّم تجربتك بالأسفل ⭐"].join("\n")
    : ["**Products**", `**${product.name}**`, "", "We hope you had a great experience with us.", "Please rate your experience below ⭐"].join("\n");
  const e = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(EMBED_THUMB)
    .setTitle(ar ? "Thank you for purchase" : "Rate your experience")
    .setDescription("\n" + desc);
  const starRow = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map(s => new ButtonBuilder()
      .setCustomId(`rate_star_${s}_${guildId}_${pid}_${lang}`)
      .setLabel("⭐".repeat(s))
      .setStyle(ButtonStyle.Secondary))
  );
  const langRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rate_lang_${guildId}_ar_${pid}`).setLabel("العربية 🇸🇦").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rate_lang_${guildId}_en_${pid}`).setLabel("English 🇬🇧").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ embeds: [e], components: [starRow, langRow] });
}

// ═══════════════ اختيار النجوم → فتح نافذة الرسالة ═══════════════
async function handleStarButton(interaction) {
  const parts = interaction.customId.split("_"); // rate_star_<n>_<guildId>_<pid>_<lang>
  const stars = parseInt(parts[2], 10);
  const guildId = parts[3];
  const pid = parts.slice(4, -1).join("_");
  const lang = parts[parts.length - 1];
  const ar = lang === "ar";
  const modal = new ModalBuilder()
    .setCustomId(`rate_comment_${guildId}_${pid}_${lang}_${stars}`)
    .setTitle(ar ? "تقييمك" : "Your review");
  const input = new TextInputBuilder()
    .setCustomId("review_comment")
    .setLabel(ar ? "اكتب رسالتك" : "Your message")
    .setPlaceholder(ar ? "اكتب رسالة ترسل في روم التقييمات ⭐" : "Write a message to be sent in the reviews room. ⭐")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// ═══════════════ إرسال التقييم ═══════════════
async function handleCommentModal(interaction) {
  const parts = interaction.customId.split("_"); // rate_comment_<guildId>_<pid>_<lang>_<stars>
  const guildId = parts[2];
  const pid = parts.slice(3, -2).join("_");
  const lang = parts[parts.length - 2];
  const stars = parseInt(parts[parts.length - 1], 10);
  const comment = interaction.fields.getTextInputValue("review_comment").trim();
  const product = findProduct(guildId, pid);
  const ar = lang === "ar";
  const client = interaction.client;
  const guild = client.guilds.cache.get(guildId) || null;

  db.ratings.add({ guildId, productId: pid, userId: interaction.user.id, stars, comment });

  // تقييم العميل يُسجَّل على طلبه هو — آخر طلب مؤكَّد أو مسلَّم لهذا المنتج —
  // حتى تظهر النجمة في سجل الطلبات وفي رسالة حالة الطلب. هذه الوصلة كانت
  // مقطوعة: زر product_rate الذي كان يكتب التقييم في الطلب لا يبنيه أحد
  // أصلاً، فبقي orders.rating فارغاً مهما تقيّم العميل وظهر "no rating" دائماً.
  // داخل try: فشل هذا لا يجب أن يمنع ردّ النافذة وإلا انتهى وقت التفاعل.
  // يُرجع رقم الطلب الذي كُتب فيه التقييم — المُستدعِي يعيد بعده رسم رسالة
  // حالة الطلب واللوحة المنشورة، وإلا يبقى "no rating" و"لم يتم التقييم"
  // على الشاشة رغم أن التقييم وصل قاعدة البيانات.
  let ratedOrderId = null;
  try {
    const pidKey = Number.isFinite(Number(pid)) ? Number(pid) : String(pid);
    let oid = db.prepare(`SELECT id FROM orders WHERE user_id=? AND product_id=? AND status IN ('confirmed','delivered') ORDER BY id DESC LIMIT 1`).get(interaction.user.id, pidKey);
    // ما لقينا طلباً مؤكَّداً أو مسلَّماً (مثلاً طلب لا يزال معلّقاً أو
    // طلب صاحب الاختبار) → آخر طلب لهذا العميل والمنتج أيًا كانت حالته،
    // بدل أن يبقى orders.rating فارغاً بصمت وتظهر اللوحة "no rating".
    if (!oid) oid = db.prepare(`SELECT id FROM orders WHERE user_id=? AND product_id=? ORDER BY id DESC LIMIT 1`).get(interaction.user.id, pidKey);
    if (oid) {
      db.prepare("UPDATE orders SET rating=?, review=? WHERE id=?").run(stars, comment, oid.id);
      ratedOrderId = Number(oid.id);
    } else {
      console.warn(`تقييم ${interaction.user.id} للمنتج ${pid}: لا يوجد طلب يحمله — لم يُكتب في orders`);
    }
  } catch (e) {
    console.warn("تعذّر كتابة تقييم العميل على الطلب: " + e.message);
  }

  await interaction.reply({
    content: ar ? "✅ شكراً على تقييمك! ⭐" : "✅ Thank you for your rating! ⭐",
    ephemeral: true,
  });

  const reviewsChannelId = ratingCfg().reviews;
  if (guild && reviewsChannelId) {
    const ch = guild.channels.cache.get(reviewsChannelId);
    if (ch) {
      const role = product?.roleId ? guild.roles.cache.get(product.roleId) : null;
      const e = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setThumbnail(EMBED_THUMB)
        .setAuthor({ name: "Feedback", iconURL: guild.iconURL({ size: 128 }) || client.user.displayAvatarURL() })
        .setDescription("We are delighted by a customer's evaluation of our services and the positive impression it left.")
        .addFields(
          { name: "**Products**", value: role ? `<@&${role.id}>` : (product?.name || "—") },
          { name: "**Rating**", value: `**${STARS_FULL[stars]} (${stars}/5)**` },
          { name: "**Comment**", value: comment ? `**${comment}**` : "—" },
          { name: "**Rating by**", value: `<@${interaction.user.id}>` },
        );
      await ch.send({ embeds: [e] }).catch(err => console.warn("فشل إرسال التقييم للروم: " + err.message));
    } else {
      console.warn(`روم التقييمات ${reviewsChannelId} غير موجود`);
    }
  } else {
    console.warn("لا يوجد روم تقييمات مضبوط بعد");
  }

  try {
    await interaction.message.edit({
      content: ar ? "✅ تم استلام تقييمك، شكراً لك! ⭐" : "✅ Your review has been received, thank you! ⭐",
      embeds: [],
      components: [],
    });
  } catch (_) {}

  // رقم الطلب الذي حمل التقييم — يُعاد للمُستدعِي كي يُعيد رسم رسالته ولوحته
  return ratedOrderId;
}

module.exports = { sendPurchaseDM, handleLangButton, handleStarButton, handleCommentModal, getProducts, findProduct, getByRole, saveRatingConfig };
