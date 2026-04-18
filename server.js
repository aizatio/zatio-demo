import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt, getCurrentUKHour } from './prompts/heat-electric.js';

const app = express();
app.use(express.json());

// ============================================================
// ENV VARIABLES (configured in Railway)
// ============================================================
const {
  ANTHROPIC_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  HANDOFF_NOTIFY_NUMBER, // NEW — where to send handoff alerts
  PORT = 3000
} = process.env;

const required = ['ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WEBHOOK_VERIFY_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

// Warn if no handoff notification number configured
if (!HANDOFF_NOTIFY_NUMBER) {
  console.warn('⚠️  HANDOFF_NOTIFY_NUMBER not set — handoff alerts will be logged only');
}

// ============================================================
// CLIENTS & CONFIG
// ============================================================
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Claude model — change to 'claude-sonnet-4-5' for smarter responses
// (Haiku is faster+cheaper, Sonnet is balanced, Opus is most capable)
const CLAUDE_MODEL = 'claude-sonnet-4-5';

// In-memory conversation storage (for demo only)
// Production would use Supabase/Postgres
const conversations = new Map();
const userProfiles = new Map(); // phone -> { name, firstSeen }

// ============================================================
// HELPERS — WhatsApp
// ============================================================

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('❌ WhatsApp send failed:', error);
    throw new Error(`WhatsApp API error: ${response.status}`);
  }

  return response.json();
}

// Mark user's message as read + show "typing…" indicator
async function sendTypingIndicator(messageId) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log('⚠️  Typing indicator failed:', error);
    } else {
      console.log('⌨️  Read receipt + typing indicator sent');
    }
  } catch (err) {
    console.log('⚠️  Typing indicator error:', err.message);
  }
}

// ============================================================
// HANDOFF NOTIFICATIONS
// Modular — add Zoho / Slack / Email easily by extending notifyHandoff()
// ============================================================

function formatConversationTranscript(history, userName) {
  const lines = history.map(msg => {
    const speaker = msg.role === 'user' ? userName : 'Sam';
    return `${speaker}: ${msg.content}`;
  });
  return lines.join('\n\n');
}

function buildHandoffAlert({ userName, phone, history, lastAIResponse }) {
  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const transcript = formatConversationTranscript(history, userName);

  // Truncate if very long (WhatsApp max is 4096 chars)
  const maxLen = 3000;
  const truncatedTranscript = transcript.length > maxLen
    ? transcript.substring(0, maxLen) + '\n\n[...conversation continues...]'
    : transcript;

  return `🔔 *New Heat Electric lead*

*${userName}*
📱 ${phone}
🕐 ${timestamp} UK

━━━━━━━━━━━━━━━━
💬 *Conversation:*

${truncatedTranscript}
━━━━━━━━━━━━━━━━

Sam flagged this for you to pick up. They may already be booking via the link above, or waiting for a callback.

Urgent channel: 0800 151 0959
— Zatio 🤖`;
}

async function sendWhatsAppHandoffAlert(alertData) {
  if (!HANDOFF_NOTIFY_NUMBER) {
    console.log('ℹ️  Skipping WhatsApp alert — no HANDOFF_NOTIFY_NUMBER configured');
    return;
  }

  const alertMessage = buildHandoffAlert(alertData);

  try {
    await sendWhatsAppMessage(HANDOFF_NOTIFY_NUMBER, alertMessage);
    console.log(`✅ Handoff WhatsApp alert sent to ${HANDOFF_NOTIFY_NUMBER}`);
  } catch (err) {
    console.error('❌ Failed to send handoff WhatsApp alert:', err.message);
  }
}

// Future: pushToZoho(), sendSlackAlert(), sendEmailCopy(), etc.
// They'll all plug into notifyHandoff() below

async function notifyHandoff(alertData) {
  console.log(`🚨 HANDOFF TRIGGERED for ${alertData.phone} — notifying channels`);

  // Run all notification channels in parallel
  await Promise.allSettled([
    sendWhatsAppHandoffAlert(alertData),
    // pushToZoho(alertData),     // Phase 2
    // sendSlackAlert(alertData), // Phase 3
    // sendEmailCopy(alertData),  // Phase 3
  ]);
}

// ============================================================
// CLAUDE
// ============================================================

async function getClaudeResponse(userMessage, conversationHistory) {
  const currentHour = getCurrentUKHour();
  const systemPrompt = getSystemPrompt(currentHour);

  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages
  });

  return response.content[0].text;
}

// ============================================================
// UX HELPERS
// ============================================================

function calculateTypingDelay(text) {
  const charCount = text.length;
  const delay = Math.min(Math.max(charCount * 25, 1500), 6000);
  return delay;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// WEBHOOK VERIFICATION (GET)
// ============================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ============================================================
// WEBHOOK RECEIVER (POST)
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Respond immediately so Meta doesn't retry

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const messageId = message.id;
    const from = message.from;
    const userText = message.text.body;
    const userName = value.contacts?.[0]?.profile?.name || 'there';

    // Don't process messages sent from OUR OWN notification account
    // (prevents infinite loops if we ever send alerts to a number that's also the bot)
    if (from === HANDOFF_NOTIFY_NUMBER) {
      console.log(`ℹ️  Ignoring message from notification recipient`);
      return;
    }

    console.log(`📩 Message from ${userName} (${from}): ${userText}`);

    // Show typing immediately
    await sendTypingIndicator(messageId);

    // Track user profile
    userProfiles.set(from, { name: userName, firstSeen: userProfiles.get(from)?.firstSeen || Date.now() });

    // Get conversation history
    let history = conversations.get(from) || [];

    // Inject user name on first message
    let contextualMessage = userText;
    if (history.length === 0) {
      contextualMessage = `[User's name: ${userName}]\n${userText}`;
    }

    // Get Claude's response
    const aiResponse = await getClaudeResponse(contextualMessage, history);
    console.log(`🤖 Claude response: ${aiResponse}`);

    // Detect handoff marker
    const needsHandoff = aiResponse.includes('[HANDOFF_TO_HUMAN]');
    const cleanResponse = aiResponse.replace('[HANDOFF_TO_HUMAN]', '').trim();

    // Save to history (clean version, without marker)
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: cleanResponse });
    conversations.set(from, history);

    // Human-like delay
    const typingDelay = calculateTypingDelay(cleanResponse);
    console.log(`⏱️  Simulating typing for ${typingDelay}ms`);
    await sleep(typingDelay);

    // Send response via WhatsApp to the user
    await sendWhatsAppMessage(from, cleanResponse);

    // If handoff triggered, notify the team
    if (needsHandoff) {
      await notifyHandoff({
        userName,
        phone: from,
        history,
        lastAIResponse: cleanResponse
      });
    }

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Zatio Demo - Heat Electric AI Assistant',
    model: CLAUDE_MODEL,
    handoffConfigured: !!HANDOFF_NOTIFY_NUMBER,
    uptime: process.uptime()
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Zatio demo running on port ${PORT} (host 0.0.0.0)`);
  console.log(`📡 Webhook endpoint: /webhook`);
  console.log(`🕐 Current UK hour: ${getCurrentUKHour().toFixed(2)}`);
  console.log(`🧠 Model: ${CLAUDE_MODEL}`);
  console.log(`📤 Handoff alerts: ${HANDOFF_NOTIFY_NUMBER ? `→ ${HANDOFF_NOTIFY_NUMBER}` : 'DISABLED (no HANDOFF_NOTIFY_NUMBER)'}`);
});
