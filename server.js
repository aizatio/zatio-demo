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
  PORT = 3000
} = process.env;

// Validate critical env vars on startup
const required = ['ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WEBHOOK_VERIFY_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// CLIENTS
// ============================================================
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Claude model — change to 'claude-sonnet-4-5' for smarter responses
// (Haiku is faster+cheaper, Sonnet is balanced, Opus is most capable)
const CLAUDE_MODEL = 'claude-haiku-4-5';

// In-memory conversation storage (for demo only)
// Production would use Supabase/Postgres
const conversations = new Map();

// ============================================================
// HELPERS
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
      text: { body: text }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('❌ WhatsApp send failed:', error);
    throw new Error(`WhatsApp API error: ${response.status}`);
  }

  return response.json();
}

// Mark message as read + show "typing…" indicator to the user
// Typing indicator auto-dismisses when we send our response (or after 25s)
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

// Human-like delay before sending response (based on message length)
// Makes Sam feel like someone actually typing, not a bot
function calculateTypingDelay(text) {
  const charCount = text.length;
  // ~25ms per char, min 1.5s, max 6s
  const delay = Math.min(Math.max(charCount * 25, 1500), 6000);
  return delay;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// WEBHOOK VERIFICATION (GET)
// Meta calls this once to verify the webhook
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
// Meta calls this every time a user sends a WhatsApp message
// ============================================================
app.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Not a user message — could be a status update, skip
    if (!message || message.type !== 'text') {
      return;
    }

    const messageId = message.id;
    const from = message.from; // user's phone number
    const userText = message.text.body;
    const userName = value.contacts?.[0]?.profile?.name || 'there';

    console.log(`📩 Message from ${userName} (${from}): ${userText}`);

    // Show "typing…" to the user immediately (feels human, not bot)
    await sendTypingIndicator(messageId);

    // Get conversation history
    let history = conversations.get(from) || [];

    // Inject user name into first-message context if this is new conversation
    let contextualMessage = userText;
    if (history.length === 0) {
      contextualMessage = `[User's name: ${userName}]\n${userText}`;
    }

    // Get Claude's response
    const aiResponse = await getClaudeResponse(contextualMessage, history);

    console.log(`🤖 Claude response: ${aiResponse}`);

    // Check for handoff marker
    const needsHandoff = aiResponse.includes('[HANDOFF_TO_HUMAN]');
    const cleanResponse = aiResponse.replace('[HANDOFF_TO_HUMAN]', '').trim();

    // Human-like delay — the longer the message, the longer Sam "types"
    const typingDelay = calculateTypingDelay(cleanResponse);
    console.log(`⏱️  Simulating typing for ${typingDelay}ms`);
    await sleep(typingDelay);

    // Save to history
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: cleanResponse });
    conversations.set(from, history);

    // Send response via WhatsApp
    await sendWhatsAppMessage(from, cleanResponse);

    if (needsHandoff) {
      console.log(`🚨 HANDOFF TRIGGERED for ${from} — human should take over`);
      // In production: notify team via email/Slack/internal notification
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
});
