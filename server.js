const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const db = new sqlite3.Database('./ticketing.db');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const pendingBookings = {};

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, date TEXT, price REAL)`);
  db.run(`CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, user_id TEXT, email TEXT, seat_number TEXT, secret_hash TEXT, status TEXT DEFAULT 'VALID')`);
  db.get(`SELECT COUNT(*) as count FROM events`, (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO events (title, date, price) VALUES ('Neon Symphony Live', '2026-08-15 20:00', 45.00)`);
    }
  });
});

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply("🎟️ **Welcome to TicketPass!**", {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Browse Events', 'list_events')],
      [Markup.button.callback('🎫 My Tickets', 'my_tickets')]
    ])
  });
});

bot.action('list_events', async (ctx) => {
  db.all(`SELECT * FROM events`, async (err, rows) => {
    if (err || rows.length === 0) return ctx.reply("No events found.");
    for (const event of rows) {
      await ctx.reply(`🎸 **${event.title}**\n📅 ${event.date}\n💵 $${event.price}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`⚡ Book Ticket ($${event.price})`, `buy_${event.id}`)]
        ])
      });
    }
  });
});

bot.action(/^buy_(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  pendingBookings[ctx.from.id] = eventId;
  await ctx.reply("📧 Please reply with the **email address** where you want your QR ticket sent:");
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const eventId = pendingBookings[userId];
  if (!eventId) return;

  const email = ctx.message.text.trim();
  if (!email.includes('@') || !email.includes('.')) {
    return ctx.reply("❌ That doesn't look like a valid email. Please enter a valid email address:");
  }

  delete pendingBookings[userId];

  db.get(`SELECT * FROM events WHERE id = ?`, [eventId], async (err, event) => {
    if (!event) return ctx.reply("Event not found.");
    const seatNumber = `Sec A, Row 4, Seat ${Math.floor(Math.random() * 20) + 1}`;
    const secretHash = crypto.randomBytes(16).toString('hex');

    db.run(`INSERT INTO tickets (event_id, user_id, email, seat_number, secret_hash) VALUES (?, ?, ?, ?, ?)`,
      [eventId, userId.toString(), email, seatNumber, secretHash], async function(err) {
        if (err) return ctx.reply("Error booking ticket.");
        const ticketId = this.lastID;

        try {
          const qrBuffer = await QRCode.toBuffer(`TICKET_ID:${ticketId}|HASH:${secretHash}`);

          await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `✅ **Confirmed!**\nEvent: ${event.title}\nSeat: ${seatNumber}\nTicket ID: #${ticketId}\n\n📨 Sending a copy to **${email}**...`,
            parse_mode: 'Markdown'
          });

          await transporter.sendMail({
            from: `"TicketPass" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Your Ticket for ${event.title} (#${ticketId})`,
            html: `<h2>Booking Confirmed!</h2>
                   <p><strong>Event:</strong> ${event.title}</p>
                   <p><strong>Date:</strong> ${event.date}</p>
                   <p><strong>Seat:</strong> ${seatNumber}</p>
                   <p><strong>Ticket ID:</strong> #${ticketId}</p>
                   <p>Please present the attached QR code at the venue entrance.</p>`,
            attachments: [{ filename: `ticket-${ticketId}.png`, content: qrBuffer }]
          });

          await ctx.reply("✅ Ticket emailed successfully!");
        } catch (e) {
          console.error(e);
          await ctx.reply(`Ticket #${ticketId} booked, but email delivery failed.`);
        }
      });
  });
});

bot.action('my_tickets', async (ctx) => {
  const userId = ctx.from.id.toString();
  db.all(`SELECT t.id, t.seat_number, e.title FROM tickets t JOIN events e ON t.event_id = e.id WHERE t.user_id = ?`, [userId], async (err, tickets) => {
    if (err || tickets.length === 0) return ctx.reply("You have no booked tickets yet.");
    let msg = "🎫 **Your Tickets:**\n\n";
    tickets.forEach(t => { msg += `• *${t.title}* — 💺 ${t.seat_number} (ID: #${t.id})\n`; });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000, () => {
  bot.launch();
  console.log('Bot running successfully.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
      
