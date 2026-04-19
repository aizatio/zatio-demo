import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { getSystemPrompt, getCurrentUKHour } from './prompts/heat-electric.js';

const app = express();
app.use(express.json());

// ============================================================
// ENV VARIABLES
// ============================================================
const {
  ANTHROPIC_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000
} = process.env;

const required = [
  'ANTHROPIC_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WEBHOOK_VERIFY_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY'
];
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
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const CLAUDE_MODEL = 'claude-sonnet-4-5';

// ============================================================
// SUPABASE HELPERS
// ============================================================

async function getTenantByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('whatsapp_phone_number_id', phoneNumberId)
    .eq('status', 'active')
    .single();
  if (error) {
    console.error('❌ Tenant lookup failed:', error.message);
    return null;
  }
  return data;
}

async function getOrCreateLead(tenantId, phone, whatsappName) {
  const { data: existing } = await supabase
    .from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('leads')
      .update({
        last_activity_at: new Date().toISOString(),
        whatsapp_name: whatsappName || existing.whatsapp_name,
      })
      .eq('id', existing.id);
    return existing;
  }

  const { data: newLead, error } = await supabase
    .from('leads')
    .insert({ tenant_id: tenantId, phone, whatsapp_name: whatsappName })
    .select()
    .single();

  if (error) {
    console.error('❌ Lead creation failed:', error.message);
    return null;
  }
  return newLead;
}

async function getOrCreateActiveConversation(tenantId, leadId) {
  const { data: active } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (active) return active;

  const { data: newConv, error } = await supabase
    .from('conversations')
    .insert({ tenant_id: tenantId, lead_id: leadId, status: 'active' })
    .select()
    .single();

  if (error) {
    console.error('❌ Conversation creation failed:', error.message);
    return null;
  }
  return newConv;
}

async function getConversationHistory(conversationId) {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return (data || []).map(m => ({ role: m.role, content: m.content }));
}

async function saveMessage({
  tenantId, conversationId, leadId, role, content,
  whatsappMessageId, modelUsed, tokensInput, tokensOutput, latencyMs, triggeredHandoff
}) {
  await supabase.from('messages').insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    lead_id: leadId,
    role,
    content,
    whatsapp_message_id: whatsappMessageId || null,
    model_used: modelUsed || null,
    tokens_input: tokensInput || null,
    tokens_output: tokensOutput || null,
    latency_ms: latencyMs || null,
    triggered_handoff: triggeredHandoff || false,
  });

  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
}

async function markConversationHandedOff(conversationId, reason) {
  await supabase
    .from('conversations')
    .update({
      status: 'handed_off',
      handed_off_at: new Date().toISOString(),
      handoff_reason: reason,
    })
    .eq('id', conversationId);
}

async function createHandoffRecord({ tenantId, conversationId, leadId, reason, notifiedTo }) {
  await supabase.from('handoffs').insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    lead_id: leadId,
    reason,
    notified_via: ['whatsapp'],
    notified_to: notifiedTo || [],
  });
}

async function logEvent(tenantId, eventType, eventData = {}, leadId = null) {
  await supabase.from('events').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    event_type: eventType,
    event_data: eventData,
  });
}

// ============================================================
// WHATSAPP HELPERS
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
// ============================================================

function formatConversationTranscript(history, userName) {
  const lines = history.map(msg => {
    const speaker = msg.role === 'user' ? userName : 'Sam';
    return `${speaker}: ${msg.content}`;
  });
  return lines.join('\n\n');
}

function buildHandoffAlert({ userName, phone, history, businessName }) {
  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const transcript = formatConversationTranscript(history, userName);
  const maxLen = 3000;
  const truncatedTranscript = transcript.length > maxLen
    ? transcript.substring(0, maxLen) + '\n\n[...conversation continues...]'
    : transcript;

  return `🔔 *New ${businessName} lead*

*${userName}*
📱 ${phone}
🕐 ${timestamp} UK

━━━━━━━━━━━━━━━━
💬 *Conversation:*

${truncatedTranscript}
━━━━━━━━━━━━━━━━

Sam flagged this for you to pick up.

— Zatio 🤖`;
}

async function notifyHandoff({ tenant, userName, phone, history, conversationId, leadId, reason }) {
  console.log(`🚨 HANDOFF TRIGGERED for ${phone} — notifying ${tenant.name}`);

  const notifiedNumbers = tenant.handoff_notify_numbers || [];
  const alertMessage = buildHandoffAlert({
    userName,
    phone,
    history,
    businessName: tenant.business_name || tenant.name,
  });

  // Send WhatsApp alert to all configured handoff numbers
  const results = await Promise.allSettled(
    notifiedNumbers.map(num => sendWhatsAppMessage(num, alertMessage))
  );

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      console.log(`✅ Handoff alert sent to ${notifiedNumbers[i]}`);
    } else {
      console.error(`❌ Handoff alert failed for ${notifiedNumbers[i]}:`, result.reason?.message);
    }
  });

  // Record in DB
  await createHandoffRecord({
    tenantId: tenant.id,
    conversationId,
    leadId,
    reason,
    notifiedTo: notifiedNumbers,
  });

  await markConversationHandedOff(conversationId, reason);

  await logEvent(tenant.id, 'handoff_triggered', { reason, phone, conversationId }, leadId);
}

// ============================================================
// CLAUDE
// ============================================================

async function getClaudeResponse(userMessage, conversationHistory, userName) {
  const currentHour = getCurrentUKHour();
  const systemPrompt = getSystemPrompt(currentHour, userName);

  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  const startTime = Date.now();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages
  });
  const latencyMs = Date.now() - startTime;

  return {
    text: response.content[0].text,
    tokensInput: response.usage?.input_tokens,
    tokensOutput: response.usage?.output_tokens,
    latencyMs,
  };
}

// ============================================================
// UX HELPERS
// ============================================================

function calculateTypingDelay(text) {
  const charCount = text.length;
  return Math.min(Math.max(charCount * 25, 1500), 6000);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function detectHandoffReason(responseText) {
  if (responseText.toLowerCase().includes('emergency') || responseText.includes('999')) {
    return 'emergency';
  }
  if (responseText.includes('bookings.cloud.microsoft') || responseText.includes('book a time')) {
    return 'booking';
  }
  if (responseText.toLowerCase().includes('speak to') || responseText.toLowerCase().includes('give you a ring')) {
    return 'human_request';
  }
  return 'other';
}

// ============================================================
// WEBHOOK VERIFICATION
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
// WEBHOOK RECEIVER
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

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
    const phoneNumberId = value.metadata?.phone_number_id;

    console.log(`📩 Message from ${userName} (${from}): ${userText}`);

    // 1. Find tenant by phone_number_id
    const tenant = await getTenantByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      console.error(`❌ No active tenant found for phone_number_id: ${phoneNumberId}`);
      return;
    }
    console.log(`🏢 Tenant: ${tenant.name}`);

    // 2. Show typing indicator
    await sendTypingIndicator(messageId);

    // 3. Get or create lead
    const lead = await getOrCreateLead(tenant.id, from, userName);
    if (!lead) {
      console.error('❌ Could not get/create lead');
      return;
    }

    // 4. Get or create active conversation
    const conversation = await getOrCreateActiveConversation(tenant.id, lead.id);
    if (!conversation) {
      console.error('❌ Could not get/create conversation');
      return;
    }

    // 5. Load conversation history from DB
    const history = await getConversationHistory(conversation.id);

    // 6. Save user message to DB
    await saveMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      leadId: lead.id,
      role: 'user',
      content: userText,
      whatsappMessageId: messageId,
    });

    // 7. Build contextual message (inject name on first message)
    let contextualMessage = userText;
    if (history.length === 0) {
      contextualMessage = `[User's name: ${userName}]\n${userText}`;
    }

    // 8. Get Claude's response
    const { text: aiResponse, tokensInput, tokensOutput, latencyMs } =
      await getClaudeResponse(contextualMessage, history, userName);
    console.log(`🤖 Claude response: ${aiResponse}`);

    // 9. Detect handoff marker
    const needsHandoff = aiResponse.includes('[HANDOFF_TO_HUMAN]');
    const cleanResponse = aiResponse.replace('[HANDOFF_TO_HUMAN]', '').trim();

    // 10. Save AI response to DB
    await saveMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      leadId: lead.id,
      role: 'assistant',
      content: cleanResponse,
      modelUsed: CLAUDE_MODEL,
      tokensInput,
      tokensOutput,
      latencyMs,
      triggeredHandoff: needsHandoff,
    });

    // 11. Human-like typing delay
    const typingDelay = calculateTypingDelay(cleanResponse);
    console.log(`⏱️  Simulating typing for ${typingDelay}ms`);
    await sleep(typingDelay);

    // 12. Send response via WhatsApp
    await sendWhatsAppMessage(from, cleanResponse);

    // 13. If handoff triggered, notify team
    if (needsHandoff) {
      const reason = detectHandoffReason(cleanResponse);
      // Build full history including the new messages for the alert
      const fullHistory = [
        ...history,
        { role: 'user', content: userText },
        { role: 'assistant', content: cleanResponse },
      ];
      await notifyHandoff({
        tenant,
        userName,
        phone: from,
        history: fullHistory,
        conversationId: conversation.id,
        leadId: lead.id,
        reason,
      });
    }

    // 14. Log event
    await logEvent(tenant.id, 'message_processed', {
      phone: from,
      message_id: messageId,
      handoff: needsHandoff,
    }, lead.id);

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
    service: 'Zatio - WhatsApp AI Assistant',
    model: CLAUDE_MODEL,
    uptime: process.uptime(),
  });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Zatio running on port ${PORT} (host 0.0.0.0)`);
  console.log(`📡 Webhook endpoint: /webhook`);
  console.log(`🕐 Current UK hour: ${getCurrentUKHour().toFixed(2)}`);
  console.log(`🧠 Model: ${CLAUDE_MODEL}`);
  console.log(`💾 Supabase: ${SUPABASE_URL ? 'connected' : 'NOT CONFIGURED'}`);
});
