# S2A DEV Discord Bot

A Discord.js v14 store/support bot with SQLite storage. This starter project uses **manual payment confirmation**: the bot never assumes a payment is real until authorized staff confirms the order.

## Requirements
- Node.js 20+
- A Discord application and bot in the Discord Developer Portal
- Enable the **Server Members Intent** in the Developer Portal (welcome messages)
- Bot permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Roles, Manage Channels
- The bot's highest role must be above product roles it grants.

## Install
1. Extract the project folder.
2. Copy `.env.example` to `.env`.
3. Fill `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
4. Run:
   ```bash
   npm install
   npm run deploy
   npm start
   ```
5. Keep the bot running. SQLite database is created at `data/d7dev.sqlite`.

## Configure channel and role IDs
Edit `config.json` and replace blank IDs with real Discord IDs. Enable Developer Mode in Discord, then right-click a channel or role and choose Copy ID.

- `channels.welcome`: welcome messages
- `channels.news`: news posts
- `channels.rules`: rules posts
- `channels.updates`: update posts
- `channels.productShowcase`: product cards
- `channels.reviews`: product and support reviews
- `channels.orders`: confirmed order log
- `channels.ticketLogs`: ticket activity log
- `channels.ticketTranscripts`: transcript archive
- `channels.adminDashboard`: admin-only dashboard channel
- `channels.salesLogs`: new manual purchase requests
- `tickets.categoryId`: optional category for ticket channels
- `roles.staff` and `roles.admin`: staff role IDs used by ticket permissions and staff checks
- `permissions.adminUserIds`: trusted admin user IDs

**Important:** restrict `adminDashboard`, `salesLogs`, `ticketLogs`, and `ticketTranscripts` to staff using Discord channel permissions. The bot does not automatically make those channels private.

## Main commands
- `/product-add` — add product, price, description, product role, image and optional download URL
- `/product-edit` — set product status to working, maintenance, or stopped
- `/product-panel` — publish product cards to configured showcase channel
- `/products` — list products privately
- `/order-create` — staff creates a manual order for a customer
- `/order-confirm` — staff confirms payment, grants product role, logs order, thanks customer, and requests product review
- `/order-deliver` — mark an order delivered and record elapsed time since confirmation
- `/orders` — show the latest orders privately to staff
- `/stats` — purchases and average ratings by product
- `/dashboard-refresh` — refresh the configured admin dashboard
- `/ticket-panel` — publish ticket opening panel
- `/embed-send` — send a custom embed with optional image
- `/post-message` — publish news, rules, or update
- `/welcome-set` — set welcome text and image URL

## Product flow
1. Staff adds product using `/product-add`.
2. Staff publishes product cards with `/product-panel`.
3. Customer clicks **Request purchase**. A pending order is created and sent to `salesLogs`.
4. Staff checks payment externally, then runs `/order-confirm order_id:<id>`.
5. Bot grants the configured product role, sends thanks and asks for a rating in DM.
6. The review is stored and sent to the configured `reviews` channel.

A product role is granted only after `/order-confirm`; this is deliberate to prevent fake purchase claims.

## Ticket flow
1. Configure `roles.staff`, `roles.admin`, `channels.ticketLogs`, `channels.ticketTranscripts`, and optionally `tickets.categoryId`.
2. Run `/ticket-panel` in a suitable channel.
3. Members create one active ticket at a time.
4. Staff claims the ticket. If `staffCanClaimOnlyOne` is enabled, one staff member cannot claim another active ticket.
5. Staff or ticket owner closes it. The bot exports up to the latest 1,000 messages as a TXT transcript, archives it, attempts to DM it to the ticket owner, and asks for a support rating.
6. Ticket ratings go to `channels.reviews`.

## Embed images
Use a direct HTTPS image URL. For private assets, upload them to Discord and use the attachment in a message where possible. Do not use links that require login.

## Notes / limitations
- Discord DMs can fail if a user blocks DMs from server members. The bot logs/handles those failures; staff should keep a manual fallback.
- The ticket transcript is plain text and captures message text, embeds, and attachment URLs; it does not download attachment files.
- `download_url` is stored for products but intentionally is not posted publicly by default. Deliver downloads only through a private ticket/DM or another access-controlled method.
- The order revenue dashboard sums prices for confirmed/delivered orders. For refunds, discounts, or partial payments, extend the schema to store paid amount/refund status.
- The dashboard updates on bot startup and key actions; use `/dashboard-refresh` to refresh manually.
- Back up `data/d7dev.sqlite` and `config.json` before updates.
- This project does not collect payment details or process payments.

## Automatic roles from the Discord control panel

1. Run `/panel` and select **Automatic Roles**.
2. Choose a role in **Choose automatic role for members** to assign it to human members when they join.
3. Optionally choose a different role in **Choose automatic role for bots**.
4. Press **Enable Auto Roles**. Changes are saved to `config.json`.

The bot needs the **Manage Roles** permission, and the bot's highest role must be above the selected roles. Automatic roles apply to new joins only; they do not retroactively change existing members.
