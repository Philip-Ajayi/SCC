const express = require('express');
const http = require('http');
const xml2js = require('xml2js');
const axios = require('axios');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const mongoose = require('mongoose');
const moment = require('moment');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const cors = require('cors');
const dotenv = require('dotenv');
const basicAuth = require('basic-auth');
const path = require('path');

dotenv.config();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;
const server = http.createServer(app);
const RSS_URL = 'https://feeds.soundcloud.com/users/soundcloud:users:1202808049/sounds.rss';

app.use(cors());
app.use(express.json());

// Basic Auth Middleware
function basicAuthMiddleware(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== 'supernatural' || user.pass !== 'supernatural') {
    res.setHeader('WWW-Authenticate', 'Basic realm="Authorization Required"');
    return res.status(401).send('Authentication required');
  }
  next();
}

// MongoDB connection
let db;
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('MongoDB connected');
    db = mongoose.connection.db;
  })
  .catch((err) => console.log('MongoDB connection error:', err));

// Subscriber model
const subscriberSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
});
const Subscriber = mongoose.model('Subscriber', subscriberSchema);

// Mail transporter
const transporter = nodemailer.createTransport({
  service: 'Zoho',
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_PASSWORD
  }
});

// ─── Radio / AutoDJ State ───────────────────────────────────────────────────────
let listeners = [];
let isLive = false;
let autodjTracks = [];
let currentAutoDJIndex = 0;
let liveTitle = '';

// ─── RSS Loading ────────────────────────────────────────────────────────────────
async function loadRSS() {
  try {
    const res = await fetch(RSS_URL);
    const xml = await res.text();
    xml2js.parseString(xml, (err, result) => {
      if (err) return console.error('RSS parse error:', err);
      autodjTracks = result.rss.channel[0].item.map(item => ({
        title: item.title[0],
        url: item.enclosure[0].$.url
      }));
      console.log('Loaded', autodjTracks.length, 'AutoDJ tracks');
    });
  } catch (err) {
    console.error('Error loading RSS:', err);
  }
}

// Initial load + refresh every 48 hours
loadRSS();
setInterval(loadRSS, 2 * 24 * 60 * 60 * 1000);

// ─── AutoDJ Loop with Full-Play Tracking ─────────────────────────────────────────
async function autoDJLoop() {
  while (true) {
    // Skip if live or no tracks
    if (isLive || autodjTracks.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    // Skip if no listeners
    if (listeners.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    const track = autodjTracks[currentAutoDJIndex % autodjTracks.length];
    console.log('AutoDJ playing:', track.title);

    let trackFinished = true;
    try {
      const response = await fetch(track.url);
      const reader = response.body;

      for await (const chunk of reader) {
        if (isLive) {
          trackFinished = false;
          break;
        }
        if (listeners.length === 0) {
          // pause streaming when no listeners
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        listeners.forEach(r => r.write(chunk));
      }
    } catch (err) {
      console.error('AutoDJ error:', err);
      trackFinished = false;
    }

    // Only increment index if fully played
    if (trackFinished) {
      currentAutoDJIndex++;
    }
  }
}
autoDJLoop();

// ─── Live Stream Endpoints ───────────────────────────────────────────────────────
app.use('/live', basicAuthMiddleware, express.raw({ type: '*/*', limit: '10mb' }));

app.post('/live', (req, res) => {
  isLive = true;
  listeners.forEach(r => r.write(req.body));
  res.sendStatus(200);
});

app.get('/listen', async (req, res) => {
  const listenerIP = req.ip || req.connection.remoteAddress;
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked'
  });
  listeners.push(res);

  const timestamp = moment().utc().format();
  if (db) {
    await db.collection('listener_attendance').insertOne({ ip: listenerIP, timestamp });
  }

  req.on('close', () => {
    listeners = listeners.filter(r => r !== res);
  });
});

app.post('/update-live-title', (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ message: 'Invalid title format.' });
  }
  liveTitle = title;
  console.log('Live title updated:', title);
  res.json({ message: 'Live title updated.' });
});

app.get('/current-track', (req, res) => {
  if (isLive) {
    return liveTitle
      ? res.json({ currentTrackTitle: liveTitle })
      : res.status(404).json({ message: 'Live stream is on, but no title set.' });
  } else {
    if (autodjTracks.length === 0) {
      return res.status(404).json({ message: 'No AutoDJ track loaded.' });
    }
    const current = autodjTracks[currentAutoDJIndex % autodjTracks.length];
    res.json({ currentTrackTitle: current.title });
  }
});

// ─── Listener Stats ─────────────────────────────────────────────────────────────
app.get('/listener-stats', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.json({ activeListeners: listeners.length });
  }
  try {
    const uniqueIPs = await db.collection('listener_attendance').aggregate([
      { $match: { timestamp: { $gte: start, $lte: end } } },
      { $group: { _id: '$ip' } }
    ]).toArray();
    res.json({ uniqueIPsCount: uniqueIPs.length });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching stats.' });
  }
});

// ─── Contact Form ───────────────────────────────────────────────────────────────
app.post('/contacting', async (req, res) => {
  const { name, email, phone, message, reason } = req.body;

  // Validate required fields
  if (!name || !email || !phone || !reason) {
    return res.status(400).send('Missing required fields.');
  }

  // Handle "location_request" differently
  if (reason === 'location_request') {
    if (message) {
      return res.status(400).send('Location requests should not include a message.');
    }

    const mailOptions = {
      from: process.env.ZOHO_EMAIL,
      to: 'info@supernaturalcc.org',
      subject: `${name} is requesting a location`,
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}`
    };

    try {
      await transporter.sendMail(mailOptions);
      return res.send('Location request sent successfully!');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Something went wrong.');
    }
  }

  // Validate message for other reasons
  if (!message) {
    return res.status(400).send('Message is required for this type of request.');
  }

  // Determine subject line based on reason
  let subject = 'New Contact Form Submission';
  if (reason === 'prayer_request') subject = `${name} needs prayer`;
  if (reason === 'ask_question') subject = `${name} has a question`;
  if (reason === 'get_involved') subject = `${name} wants to get involved`;

  const mailOptions = {
    from: process.env.ZOHO_EMAIL,
    to: 'info@supernaturalcc.org',
    subject,
    text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.send('Message sent successfully!');
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});

// ─── Subscriber API ─────────────────────────────────────────────────────────────
app.get('/api/subscribers', async (req, res) => {
  try {
    const subscribers = await Subscriber.find();
    res.json({ subscribers });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching subscribers.' });
  }
});

app.post('/api/subscribe', async (req, res) => {
  const { name, email } = req.body;
  try {
    if (await Subscriber.findOne({ email })) {
      return res.status(400).json({ message: 'Subscriber already exists.' });
    }
    await new Subscriber({ name, email }).save();
    res.status(201).json({ message: 'Subscription successful.' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

app.get('/api/subscriber/:id', async (req, res) => {
  try {
    const sub = await Subscriber.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'Not found.' });
    res.json(sub);
  } catch {
    res.status(500).json({ message: 'Error fetching subscriber.' });
  }
});

app.delete('/api/unsubscribe/:id', async (req, res) => {
  try {
    const del = await Subscriber.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ message: 'Not found.' });
    res.json({ message: 'Unsubscribed successfully.' });
  } catch {
    res.status(500).json({ message: 'Error processing request.' });
  }
});

// ─── Newsletter ─────────────────────────────────────────────────────────────────
app.post('/api/send-newsletter', async (req, res) => {
  const { customHtml } = req.body;
  try {
    const subs = await Subscriber.find();
    if (!subs.length) return res.status(404).json({ message: 'No subscribers.' });

    await Promise.all(subs.map(sub => {
      const listUnsubUrl = `/api/unsubscribe/${sub._id}`;
      const htmlUnsubUrl = `unsubscribe/${sub._id}`;
      const html = `<p>Hello ${sub.name},</p>${customHtml}<hr/>\n<p><a href=\"${htmlUnsubUrl}\">Unsubscribe</a></p>`;
      return transporter.sendMail({
        from: process.env.ZOHO_EMAIL,
        to: sub.email,
        subject: 'Newsletter',
        html,
        headers: {
          'List-Unsubscribe': `<${listUnsubUrl}>`
        }
      });
    }));

    res.json({ message: `Newsletter sent to ${subs.length} subscribers.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to send newsletter.' });
  }
});

// ─── Stripe Checkout ────────────────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  const { amount, name, email, type, event } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: type === 'event' ? `Support Event: ${event}` : 'General Offering',
            description: type === 'event' ? `Donation for event: ${event}` : 'General church offering',
          },
          unit_amount: parseInt(amount * 100, 10),
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email,
      success_url: 'https://supernaturalcc.org/success',
      cancel_url: 'https://supernaturalcc.org/cancel',
      metadata: { donor_name: name, donation_type: type },
    });
    res.json({ id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve static files from the "dist" directory
app.use(express.static(path.join(__dirname, 'dist')));

// Optional: fallback to index.html for Single Page Applications (e.g., React/Vue)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
