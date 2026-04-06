if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();
app.use('/webhook', line.middleware(config));
app.use('/api', express.json());

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: 'ok' }))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

// ── Admin API ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/api/chat-preview', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;
  if (!ADMIN_SECRET_KEY) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า ADMIN_SECRET_KEY' });
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ error: 'Admin Key ไม่ถูกต้อง' });
  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages ไม่ถูกต้อง' });
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: max_tokens || 500, system: system || 'คุณคือ ปฏิทินBoy', messages }),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) return res.status(anthropicRes.status).json({ error: data.error?.message || 'Anthropic API error' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers ──
function reply(event, messages) {
  return client.replyMessage({ replyToken: event.replyToken, messages });
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function getImageBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── User Management ──
async function getOrCreateUser(userId) {
  const { data } = await supabase.from('users').select('*').eq('line_user_id', userId).single();
  if (data) return data;
  let displayName = null;
  try {
    const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const profile = await profileRes.json();
    displayName = profile.displayName || null;
  } catch(e) {}
  const { data: newUser } = await supabase.from('users').insert({ line_user_id: userId, plan: 'free', display_name: displayName }).select().single();
  return newUser;
}

async function getUserPlan(userId) {
  const { data } = await supabase.from('users').select('plan, plan_expires_at').eq('line_user_id', userId).single();
  if (!data) return 'free';
  if (data.plan !== 'free' && data.plan_expires_at && new Date(data.plan_expires_at) < new Date()) {
    await supabase.from('users').update({ plan: 'free', plan_expires_at: null }).eq('line_user_id', userId);
    return 'free';
  }
  return data.plan || 'free';
}

function canUsePremium(plan) { return plan === 'personal' || plan === 'business'; }
function canUseBusiness(plan) { return plan === 'business'; }

// ── Appointments ──
async function getTodayAppointments(userId) {
  const today = formatDate(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })));
  const { data } = await supabase.from('appointments').select('*').eq('user_id', userId).eq('meeting_date', today).order('start_time', { ascending: true });
  return data || [];
}

async function getAllAppointments(userId) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const todayStr = formatDate(now);
  const future = new Date(now); future.setMonth(future.getMonth() + 3);
  const { data } = await supabase.from('appointments').select('*').eq('user_id', userId).gte('meeting_date', todayStr).lte('meeting_date', formatDate(future)).order('meeting_date').order('start_time');
  return data || [];
}

async function saveAndReply(event, userId, data) {
  const { title, date, time, location } = data;
  const { data: existing } = await supabase.from('appointments').select('id').eq('user_id', userId).eq('meeting_date', date).eq('start_time', `${time}:00`).eq('title', title);
  if (existing && existing.length > 0) {
    return reply(event, [flexText(`⚠️ นัดหมายซ้ำครับ\n\n"${title}" วันที่ ${date} เวลา ${time} มีอยู่แล้วในระบบครับ`, [
      { type: 'action', action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
    ])]);
  }
  const { error } = await supabase.from('appointments').insert({ user_id: userId, title, meeting_date: date, start_time: `${time}:00`, location: location || null, notes: data.notes || null });
  if (error) return reply(event, [flexText(`❌ บันทึกไม่สำเร็จ: ${error.message}`)]);
  const plan = await getUserPlan(userId);
  return reply(event, [flexSaveConfirm(title, date, time, '✅ บันทึกนัดหมายแล้วครับ', canUsePremium(plan), data.notes || null)]);
}

async function deleteAppointment(event, userId, id) {
  const { data } = await supabase.from('appointments').select('title').eq('id', id).single();
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  if (error) return reply(event, [flexText(`❌ ลบไม่สำเร็จ: ${error.message}`)]);
  return reply(event, [flexText(`🗑️ ลบ "${data?.title}" แล้วครับ`, [
    { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
    { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
  ])]);
}

// ── Claude AI ──
async function parseAppointmentWithClaude(text) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const todayStr = formatDate(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const systemPrompt = `คุณเป็น AI วิเคราะห์ข้อความนัดหมายภาษาไทย วันนี้คือ ${todayStr} พรุ่งนี้คือ ${tomorrowStr}

กฎเวลา: เที่ยง=12:00, บ่ายโมง=13:00, บ่ายสอง=14:00, บ่ายสาม=15:00, บ่ายสี่=16:00, บ่ายห้า=17:00
หกโมงเย็น=18:00, ทุ่ม=19:00, สองทุ่ม=20:00, สามทุ่ม=21:00, สี่ทุ่ม=22:00, ห้าทุ่ม=23:00
ตีหนึ่ง=01:00, ตีสอง=02:00, ตีสาม=03:00, เที่ยงคืน=00:00
3pm=15:00, 9am=09:00, เวลาทหาร 0800=08:00, 1430=14:30

กฎวัน: วันนี้=${todayStr}, พรุ่งนี้=${tomorrowStr}, มะรืน=วันหลังพรุ่งนี้
DD/MM หรือ DD/MM/YYYY → YYYY-MM-DD

ตอบเฉพาะ JSON เท่านั้น:
{"isAppointment":true/false,"title":"ชื่อนัด","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null","notes":"รายละเอียด หรือ null"}

ตัวอย่าง: "ออกกำลังกาย 6 โมงเย็น ขาช่วงล่าง" → title="ออกกำลังกาย", time="18:00", notes="ขาช่วงล่าง"`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system: systemPrompt, messages: [{ role: 'user', content: `ข้อความ: "${text}"` }] }),
    });
    const data = await res.json();
    if (!data.content?.[0]) return null;
    const content = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const match = content.match(/{[\s\S]*}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch(e) { return null; }
}

async function handleImageAppointment(event, userId, imageBase64) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const todayStr = formatDate(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);

  const prompt = `วันนี้คือ ${todayStr} พรุ่งนี้คือ ${formatDate(tomorrow)}
ดูรูปนี้และหาข้อมูลนัดหมายทั้งหมด ตอบเฉพาะ JSON array เท่านั้น:
[{"title":"ชื่อนัด","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null","notes":"รายละเอียด หรือ null"}]
ถ้าไม่พบนัดหมาย ตอบ: []`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 800,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]}]
      }),
    });
    const data = await res.json();
    if (!data.content?.[0]) return reply(event, [flexText('❌ วิเคราะห์รูปไม่ได้ครับ ลองส่งใหม่')]);
    const text = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return reply(event, [flexText('❌ ไม่พบข้อมูลนัดหมายในรูปครับ')]);
    let apts; try { apts = JSON.parse(match[0]); } catch(e) { return reply(event, [flexText('❌ วิเคราะห์รูปไม่ได้ครับ')]); }
    if (!Array.isArray(apts) || apts.length === 0) return reply(event, [flexText('🤔 ไม่พบข้อมูลนัดหมายในรูปครับ\n\nลองถ่ายรูปใบนัดที่มีวันและเวลาชัดเจนนะครับ')]);

    const first = apts[0];
    const remaining = apts.slice(1);
    if (!first.date) return reply(event, [flexText(`📅 พบนัด "${first.title}" แต่ไม่เห็นวันที่ วันไหนดีครับ?`, [
      { type: 'action', action: { type: 'message', label: 'วันนี้', text: `${first.title} วันนี้ ${first.time || ''}`.trim() } },
      { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: `${first.title} พรุ่งนี้ ${first.time || ''}`.trim() } },
    ])]);
    if (!first.time) return reply(event, [flexText(`⏰ พบนัด "${first.title}" แต่ไม่เห็นเวลา กี่โมงครับ?`)]);

    await supabase.from('appointments').insert({ user_id: userId, title: first.title, meeting_date: first.date, start_time: `${first.time}:00`, location: first.location || null, notes: first.notes || null });

    if (remaining.length > 0) {
      userState[userId] = { step: 'pendingImageApts', apts: remaining };
      const plan = await getUserPlan(userId);
      const next = remaining[0];
      return reply(event, [
        flexSaveConfirm(first.title, first.date, first.time, `✅ บันทึกนัด 1/${apts.length} แล้วครับ`, canUsePremium(plan), first.notes),
        flexText(`📋 พบนัดถัดไป: "${next.title}" ${next.date || ''} ${next.time || ''}\n\nบันทึกต่อไหมครับ?`, [
          { type: 'action', action: { type: 'message', label: '✅ บันทึกต่อ', text: 'บันทึกนัดต่อไป' } },
          { type: 'action', action: { type: 'message', label: '⛔ หยุด', text: 'หยุด' } },
        ])
      ]);
    }
    const plan = await getUserPlan(userId);
    return reply(event, [flexSaveConfirm(first.title, first.date, first.time, '✅ บันทึกนัดหมายแล้วครับ', canUsePremium(plan), first.notes)]);
  } catch(e) { return reply(event, [flexText('❌ เกิดข้อผิดพลาดครับ ลองใหม่อีกครั้ง')]); }
}

// ── Team Management ──
function generateCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

async function createInviteLink(teamId, userId) {
  const code = generateCode();
  await supabase.from('team_invites').insert({ team_id: teamId, code, created_by: userId });
  return code;
}

async function joinTeamByCode(event, userId, code) {
  const { data: invite } = await supabase.from('team_invites').select('*, teams(name)').eq('code', code.toUpperCase()).single();
  if (!invite) return reply(event, [flexText('❌ ไม่พบ code เชิญ หรือ code หมดอายุแล้วครับ')]);
  if (new Date(invite.expires_at) < new Date()) return reply(event, [flexText('❌ Link เชิญนี้หมดอายุแล้วครับ กรุณาขอ Link ใหม่จากเจ้าของทีม')]);
  const { error } = await supabase.from('team_members').insert({ team_id: invite.team_id, line_user_id: userId, role: 'member' });
  if (error) return reply(event, [flexText(`✅ คุณเป็นสมาชิกทีม "${invite.teams?.name}" อยู่แล้วครับ`)]);
  return reply(event, [flexText(`🎉 เข้าร่วมทีม "${invite.teams?.name}" สำเร็จแล้วครับ!`, [
    { type: 'action', action: { type: 'message', label: '👥 ดูทีม', text: 'จัดการทีม' } },
  ])]);
}

async function handleTeam(event, userId) {
  const plan = await getUserPlan(userId);
  if (!canUseBusiness(plan)) return reply(event, [flexText('🔒 ฟีเจอร์จัดการทีมสำหรับ Business Plan เท่านั้นครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียด')]);
  const { data: ownTeams } = await supabase.from('teams').select('*').eq('owner_line_id', userId);
  const { data: memberTeams } = await supabase.from('team_members').select('team_id, teams(id, name)').eq('line_user_id', userId);
  return reply(event, [flexTeamMenu(ownTeams || [], memberTeams || [])]);
}

// ── Reminder System ──
async function handleSetReminder(event, userId, aptId, minutesBefore) {
  const plan = await getUserPlan(userId);
  if (!canUsePremium(plan)) return reply(event, [flexText('🔒 ฟีเจอร์นี้สำหรับ Personal Plan ขึ้นไปครับ')]);
  const { data: apt } = await supabase.from('appointments').select('*').eq('id', aptId).single();
  if (!apt) return reply(event, [flexText('❌ ไม่พบนัดหมายครับ')]);
  let reminders = apt.reminders || [];
  if (canUseBusiness(plan)) {
    if (!reminders.find(r => r.minutes === minutesBefore)) reminders.push({ minutes: minutesBefore, sent: false });
  } else {
    reminders = [{ minutes: minutesBefore, sent: false }];
  }
  await supabase.from('appointments').update({ reminders, reminded: false }).eq('id', aptId);
  const formatMins = (m) => m >= 1440 ? `${m/1440} วันก่อน` : m >= 60 ? `${m/60} ชั่วโมงก่อน` : `${m} นาทีก่อน`;
  const reminderList = reminders.map((r, i) => `${i+1}. ⏰ ${formatMins(r.minutes)}`).join('\n');
  return reply(event, [flexText(`✅ ตั้งแจ้งเตือน "${apt.title}"\n\nแจ้งเตือนที่ตั้งไว้:\n${reminderList}`, canUseBusiness(plan) ? [
    { type: 'action', action: { type: 'message', label: '➕ เพิ่มช่วงเวลาอีก', text: 'ตั้งแจ้งเตือน' } },
    { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
  ] : [
    { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
  ])]);
}

// ── Check Reminders (ทุก 1 นาที) ──
async function checkReminders() {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const todayStr = formatDate(now);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    console.log(`🔔 ${todayStr} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);

    // Free plan 30 นาที
    const target30 = new Date(now.getTime() + 30 * 60 * 1000);
    const targetTime = `${String(target30.getHours()).padStart(2,'0')}:${String(target30.getMinutes()).padStart(2,'0')}:00`;
    const { data: freeApts } = await supabase.from('appointments').select('*').eq('meeting_date', todayStr).eq('start_time', targetTime).eq('reminded', false);
    for (const apt of (freeApts || [])) {
      if (apt.reminders && apt.reminders.length > 0) continue;
      try {
        await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt, 30)] });
        await supabase.from('appointments').update({ reminded: true }).eq('id', apt.id);
        console.log(`✅ แจ้งเตือน 30 นาที: ${apt.title}`);
      } catch(e) { console.error('Push error:', e.message); }
    }

    // Custom reminders
    const { data: customApts } = await supabase.from('appointments').select('*').eq('meeting_date', todayStr).not('reminders', 'eq', '[]').not('reminders', 'is', null);
    for (const apt of (customApts || [])) {
      const reminders = apt.reminders || [];
      const [h, m] = apt.start_time.slice(0,5).split(':').map(Number);
      const aptMins = h * 60 + m;
      for (let i = 0; i < reminders.length; i++) {
        const r = reminders[i];
        if (r.sent) continue;
        if (currentMins === aptMins - r.minutes) {
          try {
            await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt, r.minutes)] });
            reminders[i].sent = true;
            await supabase.from('appointments').update({ reminders }).eq('id', apt.id);
            console.log(`✅ แจ้งเตือน ${r.minutes} นาที: ${apt.title}`);
          } catch(e) { console.error('Push error:', e.message); }
        }
      }
    }

    // Auto-delete วันเก่า
    const { data: pastApts } = await supabase.from('appointments').select('id, title, meeting_date').lt('meeting_date', todayStr);
    for (const apt of (pastApts || [])) {
      await supabase.from('appointments').delete().eq('id', apt.id);
      console.log(`🗑️ Auto-delete (past): ${apt.title}`);
    }

    // Auto-delete วันนี้ที่เกิน 1 ชั่วโมง
    const { data: todayApts } = await supabase.from('appointments').select('id, title, start_time').eq('meeting_date', todayStr);
    for (const apt of (todayApts || [])) {
      const [h, m] = apt.start_time.slice(0,5).split(':').map(Number);
      if (currentMins >= h * 60 + m + 60) {
        await supabase.from('appointments').delete().eq('id', apt.id);
        console.log(`🗑️ Auto-delete (today): ${apt.title}`);
      }
    }
  } catch(e) { console.error('checkReminders error:', e); }
}
setInterval(checkReminders, 60 * 1000);

// ── State Management ──
const userState = {};

// ── Main Event Handler ──
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'follow') {
    await getOrCreateUser(userId);
    return reply(event, [flexWelcome()]);
  }

  if (event.type !== 'message') return;

  if (event.message.type === 'image') {
    const plan = await getUserPlan(userId);
    if (!canUsePremium(plan)) return reply(event, [flexText('🔒 การส่งรูปเพื่อนัดหมายสำหรับ Personal Plan ขึ้นไปครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียด')]);
    try {
      const imageBase64 = await getImageBase64(event.message.id);
      return await handleImageAppointment(event, userId, imageBase64);
    } catch(e) { return reply(event, [flexText('❌ ไม่สามารถอ่านรูปได้ครับ ลองส่งใหม่')]); }
  }

  if (event.message.type !== 'text') return;
  const msg = event.message.text.trim();

  // State handlers
  if (userState[userId]) {
    const state = userState[userId];

    if (state.step === 'creatingTeam') {
      const teamName = msg.trim();
      if (!teamName) return reply(event, [flexText('❌ กรุณาพิมพ์ชื่อทีมครับ')]);
      const { error } = await supabase.from('teams').insert({ name: teamName, owner_line_id: userId });
      delete userState[userId];
      if (error) return reply(event, [flexText('❌ สร้างทีมไม่สำเร็จครับ')]);
      return reply(event, [flexText(`✅ สร้างทีม "${teamName}" สำเร็จแล้วครับ!`, [
        { type: 'action', action: { type: 'message', label: '👥 จัดการทีม', text: 'จัดการทีม' } },
      ])]);
    }

    if (state.step === 'editing') {
      const parsed = await parseAppointmentWithClaude(msg);
      if (!parsed || !parsed.isAppointment) { delete userState[userId]; return reply(event, [flexText('❌ ไม่เข้าใจครับ ยกเลิกการแก้ไขแล้ว')]); }
      const updateData = { reminded: false };
      if (parsed.title) updateData.title = parsed.title;
      if (parsed.date) updateData.meeting_date = parsed.date;
      if (parsed.time) updateData.start_time = `${parsed.time}:00`;
      if (parsed.location) updateData.location = parsed.location;
      if (parsed.notes) updateData.notes = parsed.notes;
      const { error } = await supabase.from('appointments').update(updateData).eq('id', state.apt.id);
      delete userState[userId];
      if (error) return reply(event, [flexText(`❌ แก้ไขไม่สำเร็จ: ${error.message}`)]);
      return reply(event, [flexSaveConfirm(parsed.title || state.apt.title, parsed.date || state.apt.meeting_date, parsed.time || state.apt.start_time.slice(0,5), '✏️ แก้ไขนัดหมายแล้วครับ')]);
    }
  }

  // Quick actions
  if (msg.startsWith('ลบ:')) { delete userState[userId]; return await deleteAppointment(event, userId, msg.replace('ลบ:', '')); }
  if (msg.startsWith('แก้ไข:')) {
    delete userState[userId];
    const { data } = await supabase.from('appointments').select('*').eq('id', msg.replace('แก้ไข:', '')).single();
    if (data) { userState[userId] = { step: 'editing', apt: data }; return reply(event, [flexText(`✏️ แก้ไข "${data.title}"\n\nบอกข้อมูลใหม่ได้เลยครับ`)]); }
    return reply(event, [flexText('❌ ไม่พบนัดหมายครับ')]);
  }
  if (/^แจ้งเตือน\d+$/.test(msg)) {
    const mins = parseInt(msg.replace('แจ้งเตือน', ''));
    const state = userState[userId];
    if (state?.aptId) { const aptId = state.aptId; delete userState[userId]; return await handleSetReminder(event, userId, aptId, mins); }
    return reply(event, [flexText('❌ กรุณาเลือกนัดหมายก่อนครับ')]);
  }
  if (msg.startsWith('link:')) {
    const teamName = msg.replace('link:', '');
    const { data: team } = await supabase.from('teams').select('id, name').eq('name', teamName).eq('owner_line_id', userId).single();
    if (!team) return reply(event, [flexText('❌ ไม่พบทีมครับ')]);
    const code = await createInviteLink(team.id, userId);
    return reply(event, [flexText(`🔗 Link เชิญเข้าทีม "${team.name}"\n\nส่งข้อความนี้ให้สมาชิกพิมพ์ใน ปฏิทินBoy:\n\n👉 เข้าร่วม ${code}\n\n⏰ หมดอายุใน 7 วันครับ`)]);
  }
  if (msg.startsWith('สมาชิก:')) {
    const teamName = msg.replace('สมาชิก:', '');
    const { data: team } = await supabase.from('teams').select('id').eq('name', teamName).eq('owner_line_id', userId).single();
    if (!team) return reply(event, [flexText('❌ ไม่พบทีมครับ')]);
    const { data: members } = await supabase.from('team_members').select('*').eq('team_id', team.id);
    const count = members?.length || 0;
    const list = count > 0 ? members.map((m, i) => `${i+1}. สมาชิก (${m.role})`).join('\n') : 'ยังไม่มีสมาชิกครับ';
    return reply(event, [flexText(`👥 สมาชิกทีม "${teamName}"\n\n${list}\n\nรวม ${count} คนครับ`)]);
  }
  if (msg.startsWith('เข้าร่วม')) {
    const code = msg.replace('เข้าร่วม', '').trim();
    if (code) return await joinTeamByCode(event, userId, code);
  }

  // บันทึกนัดต่อไป (จากรูปหลายนัด)
  if (msg === 'บันทึกนัดต่อไป') {
    const state = userState[userId];
    if (!state || state.step !== 'pendingImageApts' || !state.apts?.length) return reply(event, [flexText('❌ ไม่มีนัดค้างอยู่แล้วครับ')]);
    const apt = state.apts[0];
    const remaining = state.apts.slice(1);
    if (!apt.date || !apt.time) { delete userState[userId]; return reply(event, [flexText(`⚠️ ข้อมูลนัด "${apt.title}" ไม่ครบครับ`)]); }
    await supabase.from('appointments').insert({ user_id: userId, title: apt.title, meeting_date: apt.date, start_time: `${apt.time}:00`, location: apt.location || null, notes: apt.notes || null });
    if (remaining.length > 0) {
      userState[userId] = { step: 'pendingImageApts', apts: remaining };
      const next = remaining[0];
      const plan = await getUserPlan(userId);
      return reply(event, [
        flexSaveConfirm(apt.title, apt.date, apt.time, '✅ บันทึกแล้วครับ', canUsePremium(plan), apt.notes),
        flexText(`📋 นัดถัดไป: "${next.title}" ${next.date || ''} ${next.time || ''}\n\nบันทึกต่อไหมครับ?`, [
          { type: 'action', action: { type: 'message', label: '✅ บันทึกต่อ', text: 'บันทึกนัดต่อไป' } },
          { type: 'action', action: { type: 'message', label: '⛔ หยุด', text: 'หยุด' } },
        ])
      ]);
    }
    delete userState[userId];
    const plan = await getUserPlan(userId);
    return reply(event, [flexSaveConfirm(apt.title, apt.date, apt.time, '✅ บันทึกครบทุกนัดแล้วครับ 🎉', canUsePremium(plan), apt.notes)]);
  }
  if (msg === 'หยุด' && userState[userId]?.step === 'pendingImageApts') {
    const count = userState[userId].apts.length;
    delete userState[userId];
    return reply(event, [flexText(`⛔ หยุดแล้วครับ เหลืออีก ${count} นัดที่ยังไม่ได้บันทึก`)]);
  }

  // Menu commands
  if (msg === 'สวัสดี' || msg === 'หวัดดี') return reply(event, [flexWelcome()]);
  if (msg === 'เมนู') return reply(event, [await flexMenu(userId)]);
  if (msg === 'เพิ่มนัด') return reply(event, [flexAddAppointment()]);
  if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') return reply(event, [flexSchedule(await getTodayAppointments(userId))]);
  if (msg === 'นัดหมายทั้งหมด' || msg === 'นัดทั้งหมด') return reply(event, [flexAllSchedule(await getAllAppointments(userId))]);
  if (msg === 'จัดการนัด') return reply(event, [flexManageMenu()]);
  if (msg === 'ติดต่อเรา') return reply(event, [flexContact()]);
  if (msg === 'ทีม' || msg === 'จัดการทีม') return await handleTeam(event, userId);

  if (msg === 'แพลน' || msg === 'plan') {
    const user = await getOrCreateUser(userId);
    return reply(event, [flexPlan(user?.plan || 'free', user?.plan_expires_at)]);
  }
  if (msg === 'อัปเกรด Personal' || msg === 'อัปเกรด Business') {
    const planName = msg.includes('Personal') ? 'Personal ฿30/เดือน' : 'Business ฿199/เดือน';
    return reply(event, [flexText(`💳 อัปเกรด ${planName}\n\nโอนเงินมาที่:\nธนาคาร: [ชื่อธนาคาร]\nเลขบัญชี: [เลขบัญชี]\nชื่อ: [ชื่อบัญชี]\n\nแล้วส่งสลิปมาที่นี่เลยครับ ทีมงานจะอัปเกรดให้ภายใน 30 นาที 😊`)]);
  }

  if (msg === 'สร้างทีม') {
    const plan = await getUserPlan(userId);
    if (!canUseBusiness(plan)) return reply(event, [flexText('🔒 สำหรับ Business Plan เท่านั้นครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียด')]);
    userState[userId] = { step: 'creatingTeam' };
    return reply(event, [flexText('👥 ตั้งชื่อทีมได้เลยครับ\n\nเช่น: ทีมขาย, ทีม HR, ออฟฟิศ A')]);
  }

  if (msg === 'ลบนัดหมาย') {
    const apts = await getAllAppointments(userId);
    if (apts.length === 0) return reply(event, [flexText('ไม่มีนัดหมายครับ 😊')]);
    userState[userId] = { step: 'selectDelete', apts };
    return reply(event, [flexSelectAppointment(apts, 'ลบ')]);
  }
  if (msg === 'แก้ไขนัดหมาย') {
    const apts = await getAllAppointments(userId);
    if (apts.length === 0) return reply(event, [flexText('ไม่มีนัดหมายครับ 😊')]);
    userState[userId] = { step: 'selectEdit', apts };
    return reply(event, [flexSelectAppointment(apts, 'แก้ไข')]);
  }
  if (msg === 'ตั้งแจ้งเตือน') {
    const plan = await getUserPlan(userId);
    if (!canUsePremium(plan)) return reply(event, [flexText('🔒 ฟีเจอร์นี้สำหรับ Personal Plan ขึ้นไปครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียด')]);
    const apts = await getAllAppointments(userId);
    if (apts.length === 0) return reply(event, [flexText('ไม่มีนัดหมายครับ 😊')]);
    userState[userId] = { step: 'selectReminder', apts };
    return reply(event, [flexSelectReminderApt(apts)]);
  }
  if (userState[userId]?.step === 'selectReminder') {
    const state = userState[userId];
    const apt = state.apts?.find(a => a.title === msg || msg.includes(a.title));
    if (apt) {
      const plan = await getUserPlan(userId);
      userState[userId] = { step: 'pickReminderTime', aptId: apt.id };
      return reply(event, [flexSetReminder(apt.id, canUseBusiness(plan))]);
    }
    delete userState[userId];
    return reply(event, [flexText('❌ ไม่พบนัดหมายครับ ลองใหม่อีกครั้ง')]);
  }

  if (msg === 'แจ้งปัญหาการใช้งาน' || msg === 'แนะนำฟีเจอร์' || msg === 'สอบถามแผนและราคา' || msg === 'อื่นๆ') {
    return reply(event, [flexText(`✅ รับเรื่องแล้วครับ!\n\nหัวข้อ: ${msg}\nทีมงานจะติดต่อกลับภายใน 24 ชั่วโมงครับ 😊`, [
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ])]);
  }

  // Claude AI parse
  const parsed = await parseAppointmentWithClaude(msg);
  if (!parsed || !parsed.isAppointment) {
    return reply(event, [flexText('💬 ไม่เข้าใจครับ\n\nบอกนัดหมายได้เลย เช่น "พรุ่งนี้ บ่ายโมง ประชุมทีม"\nหรือพิมพ์ "เมนู" เพื่อดูคำสั่ง', [
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ])]);
  }
  if (!parsed.date) return reply(event, [flexText(`📅 "${parsed.title}" — วันไหนครับ?`, [
    { type: 'action', action: { type: 'message', label: 'วันนี้', text: `${parsed.title} วันนี้ ${parsed.time || ''}`.trim() } },
    { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: `${parsed.title} พรุ่งนี้ ${parsed.time || ''}`.trim() } },
  ])]);
  if (!parsed.time) return reply(event, [flexText(`⏰ "${parsed.title}" — กี่โมงครับ?\n\nเช่น: 14:00 / บ่ายสอง / 1400`)]);
  return await saveAndReply(event, userId, parsed);
}


// ── FLEX: Text Card ──
function flexText(text, quickReplyItems = null) {
  const lines = text.split('\n');
  const title = lines[0];
  const body = lines.slice(1).join('\n').trim();
  let headerColor = '#06C755';
  if (title.startsWith('❌')) headerColor = '#ef4444';
  else if (title.startsWith('⚠️')) headerColor = '#f59e0b';
  else if (title.startsWith('⏰')) headerColor = '#FF6B35';
  else if (title.startsWith('🔒')) headerColor = '#8b5cf6';
  else if (title.startsWith('📅') || title.startsWith('📋') || title.startsWith('💬')) headerColor = '#3b82f6';
  else if (title.startsWith('✏️')) headerColor = '#f59e0b';
  else if (title.startsWith('👥')) headerColor = '#8b5cf6';
  else if (title.startsWith('💳')) headerColor = '#3b82f6';

  const msg = {
    type: 'flex', altText: title.replace(/[✅❌⏰🔒📅📋✏️🎉👥💬🗑️⚠️💳🔗]/g, '').trim() || text.slice(0, 40),
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'text', text: title, size: 'md', weight: 'bold', color: headerColor, wrap: true },
          ...(body ? [{ type: 'text', text: body, size: 'sm', color: '#475569', wrap: true, margin: 'sm' }] : []),
        ],
      },
    },
  };
  if (quickReplyItems) return { ...msg, quickReply: { items: quickReplyItems } };
  return msg;
}

// ── FLEX: Welcome ──
function flexWelcome() {
  return {
    type: 'flex', altText: 'สวัสดีครับ! ผม ปฏิทินBoy',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '20px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'สวัสดีครับ!', size: 'xxl', weight: 'bold', color: '#ffffff', margin: 'xs' },
          { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#06C755', cornerRadius: '20px', paddingAll: '6px', paddingStart: '10px', paddingEnd: '10px',
                contents: [{ type: 'text', text: 'ฟรีตลอด', size: 'xs', color: '#ffffff', weight: 'bold' }] },
              { type: 'box', layout: 'vertical', backgroundColor: '#FF6B35', cornerRadius: '20px', paddingAll: '6px', paddingStart: '10px', paddingEnd: '10px',
                contents: [{ type: 'text', text: 'แจ้งเตือนอัตโนมัติ', size: 'xs', color: '#ffffff', weight: 'bold' }] },
            ],
          },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'text', text: 'บอกนัดหมายได้เลยครับ', size: 'sm', weight: 'bold', color: '#111111' },
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
            contents: [
              { type: 'text', text: '"พรุ่งนี้ บ่ายโมง ประชุมทีม"', size: 'sm', color: '#6b7280' },
              { type: 'text', text: '"วันนี้ 3 ทุ่ม กินข้าวกับครอบครัว"', size: 'sm', color: '#6b7280', margin: 'xs' },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '📅 ดูกำหนดการวันนี้', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนูทั้งหมด', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: Menu ──
async function flexMenu(userId) {
  const plan = userId ? await getUserPlan(userId) : 'free';
  const planLabel = plan === 'business' ? 'BUSINESS' : plan === 'personal' ? 'PERSONAL' : 'FREE';
  const planColor = plan === 'business' ? '#a78bfa' : plan === 'personal' ? '#93c5fd' : '#94a3b8';
  const isPremium = canUsePremium(plan);
  const isBusiness = canUseBusiness(plan);

  const menuRow = (icon, title, subtitle, action, locked = false, lockColor = 'blue', highlight = null) => ({
    type: 'box', layout: 'horizontal',
    backgroundColor: locked ? '#f1f5f9' : highlight === 'blue' ? '#eff6ff' : highlight === 'purple' ? '#f5f3ff' : '#f9fafb',
    cornerRadius: '10px', paddingAll: '11px', margin: 'xs', alignItems: 'center',
    action: locked ? undefined : { type: 'message', label: title, text: action },
    contents: [
      { type: 'text', text: icon, size: 'md', flex: 0, margin: 'none' },
      { type: 'box', layout: 'vertical', flex: 1, paddingStart: '10px',
        contents: [
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: locked ? '#94a3b8' : highlight === 'blue' ? '#1e40af' : highlight === 'purple' ? '#5b21b6' : '#0f172a' },
          { type: 'text', text: subtitle, size: 'xxs', color: locked ? '#94a3b8' : highlight === 'blue' ? '#3b82f6' : highlight === 'purple' ? '#8b5cf6' : '#64748b', margin: 'xs' },
        ],
      },
      locked
        ? { type: 'box', layout: 'vertical', flex: 0, cornerRadius: '20px', paddingAll: '3px', paddingStart: '6px', paddingEnd: '6px', backgroundColor: lockColor === 'purple' ? '#ede9fe' : '#dbeafe', contents: [{ type: 'text', text: '🔒', size: 'xxs', color: lockColor === 'purple' ? '#7c3aed' : '#2563eb' }] }
        : { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
    ],
  });

  return {
    type: 'flex', altText: 'ปฏิทินBoy เมนูหลัก',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'เมนูหลัก', size: 'xl', weight: 'bold', color: '#ffffff', margin: 'xs' },
          { type: 'text', text: `● ${planLabel}`, size: 'xxs', color: planColor, weight: 'bold', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          menuRow('🗓', 'กำหนดการวันนี้', 'นัดหมายของวันนี้', 'กำหนดการ'),
          menuRow('📆', 'นัดหมายทั้งหมด', 'ดูนัดทั้งเดือน', 'นัดหมายทั้งหมด'),
          menuRow('📋', 'จัดการนัด', isPremium ? 'แก้ไข / ลบ / แจ้งเตือน' : 'แก้ไข / ลบ', 'จัดการนัด'),
          menuRow('📤', 'Export PDF/Excel', isPremium ? 'Personal' : 'Personal+', isPremium ? 'export' : '', !isPremium, 'blue', isPremium ? 'blue' : null),
          menuRow('👥', 'จัดการทีม', isBusiness ? 'Business' : 'Business', isBusiness ? 'ทีม' : '', !isBusiness, 'purple', isBusiness ? 'purple' : null),
          { type: 'separator', margin: 'sm' },
          menuRow('💳', 'แพลนของฉัน', `${planLabel} · ${plan === 'business' ? '฿199/เดือน' : plan === 'personal' ? '฿30/เดือน' : 'ฟรีตลอด'}`, 'แพลน'),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '+ เพิ่มนัดหมายใหม่', text: 'เพิ่มนัด' } },
        ],
      },
    },
  };
}

// ── FLEX: Manage Menu ──
function flexManageMenu() {
  return {
    type: 'flex', altText: '📋 จัดการนัดหมาย',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📋 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'จัดการนัดหมาย', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '14px', alignItems: 'center',
            action: { type: 'message', label: 'แก้ไขนัด', text: 'แก้ไขนัดหมาย' },
            contents: [
              { type: 'text', text: '✏️', size: 'lg', flex: 0 },
              { type: 'box', layout: 'vertical', flex: 1, paddingStart: '12px',
                contents: [
                  { type: 'text', text: 'แก้ไขนัดหมาย', size: 'sm', weight: 'bold', color: '#0f172a' },
                  { type: 'text', text: 'แก้ไขชื่อ วัน เวลา สถานที่', size: 'xs', color: '#64748b', margin: 'xs' },
                ]},
              { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
            ]},
          { type: 'box', layout: 'horizontal', backgroundColor: '#fff5f5', cornerRadius: '10px', paddingAll: '14px', alignItems: 'center',
            action: { type: 'message', label: 'ลบนัด', text: 'ลบนัดหมาย' },
            contents: [
              { type: 'text', text: '🗑️', size: 'lg', flex: 0 },
              { type: 'box', layout: 'vertical', flex: 1, paddingStart: '12px',
                contents: [
                  { type: 'text', text: 'ลบนัดหมาย', size: 'sm', weight: 'bold', color: '#ef4444' },
                  { type: 'text', text: 'ลบนัดหมายออกจากระบบ', size: 'xs', color: '#f87171', margin: 'xs' },
                ]},
              { type: 'text', text: '›', size: 'lg', color: '#fca5a5', flex: 0 },
            ]},
          { type: 'box', layout: 'horizontal', backgroundColor: '#f0f9ff', cornerRadius: '10px', paddingAll: '14px', alignItems: 'center',
            action: { type: 'message', label: 'ตั้งแจ้งเตือน', text: 'ตั้งแจ้งเตือน' },
            contents: [
              { type: 'text', text: '⏰', size: 'lg', flex: 0 },
              { type: 'box', layout: 'vertical', flex: 1, paddingStart: '12px',
                contents: [
                  { type: 'text', text: 'ตั้งเวลาแจ้งเตือน', size: 'sm', weight: 'bold', color: '#1e40af' },
                  { type: 'text', text: 'Personal+ เลือกเวลาแจ้งเตือนเอง', size: 'xs', color: '#3b82f6', margin: 'xs' },
                ]},
              { type: 'text', text: '›', size: 'lg', color: '#93c5fd', flex: 0 },
            ]},
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '← กลับเมนูหลัก', text: 'เมนู' } }],
      },
    },
  };
}

// ── FLEX: Add Appointment ──
function flexAddAppointment() {
  return {
    type: 'flex', altText: 'เพิ่มนัดหมายใหม่',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'เพิ่มนัดหมาย', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          { type: 'text', text: 'พิมพ์บอกได้เลยครับ เช่น:', size: 'sm', color: '#374151', weight: 'bold' },
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '14px',
            contents: [
              { type: 'text', text: '"ประชุมทีม พรุ่งนี้ 10 โมง"', size: 'sm', color: '#6b7280' },
              { type: 'text', text: '"นัดหมอ 15/4 บ่ายสอง รพ.กรุงเทพ"', size: 'sm', color: '#6b7280', margin: 'xs' },
              { type: 'text', text: '"ออกกำลังกาย วันนี้ 6 โมงเย็น"', size: 'sm', color: '#6b7280', margin: 'xs' },
            ],
          },
        ],
      },
    },
  };
}

// ── FLEX: Schedule Today ──
function flexSchedule(apts) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const dayNames = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const dateLabel = `${dayNames[now.getDay()]}ที่ ${now.getDate()} ${monthNames[now.getMonth()]}`;

  const items = apts.length > 0 ? apts.map(apt => ({
    type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
    contents: [
      { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
      { type: 'box', layout: 'horizontal', margin: 'xs', spacing: 'sm',
        contents: [
          { type: 'text', text: `⏰ ${apt.start_time.slice(0,5)}`, size: 'xs', color: '#6b7280', flex: 0 },
          ...(apt.location ? [{ type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#6b7280', flex: 1, wrap: true }] : []),
        ],
      },
      ...(apt.notes ? [{ type: 'text', text: `📝 ${apt.notes}`, size: 'xs', color: '#9ca3af', margin: 'xs', wrap: true }] : []),
    ],
  })) : [{ type: 'box', layout: 'vertical', paddingAll: '20px', contents: [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ 😊', size: 'sm', color: '#6b7280', align: 'center' }] }];

  return {
    type: 'flex', altText: `กำหนดการวันนี้ ${dateLabel}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 กำหนดการวันนี้', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: dateLabel, size: 'lg', weight: 'bold', color: '#06C755' },
          { type: 'text', text: `${apts.length} นัดหมาย`, size: 'xs', color: '#64748b', margin: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '+ เพิ่มนัดหมาย', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: All Schedule ──
function flexAllSchedule(apts) {
  const dayNames = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  const groups = {};
  for (const apt of apts) { if (!groups[apt.meeting_date]) groups[apt.meeting_date] = []; groups[apt.meeting_date].push(apt); }

  const bubbles = Object.entries(groups).slice(0, 12).map(([date, dayApts]) => {
    const d = new Date(date + 'T00:00:00');
    const dayLabel = `${dayNames[d.getDay()]}ที่ ${d.getDate()} ${monthNames[d.getMonth()]}`;
    const items = dayApts.map(apt => ({
      type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'xs', alignItems: 'center',
      contents: [
        { type: 'box', layout: 'vertical', flex: 1,
          contents: [
            { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
            { type: 'text', text: `⏰ ${apt.start_time.slice(0,5)}${apt.location ? '  📍 ' + apt.location : ''}`, size: 'xs', color: '#6b7280', margin: 'xs' },
          ],
        },
      ],
    }));
    return {
      type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '12px',
        contents: [
          { type: 'text', text: 'นัดหมายทั้งหมด', size: 'xxs', color: '#94a3b8' },
          { type: 'text', text: dayLabel, size: 'sm', weight: 'bold', color: '#06C755' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'xs', contents: items },
      footer: { type: 'box', layout: 'vertical', paddingAll: '10px',
        contents: [{ type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } }],
      },
    };
  });

  if (bubbles.length === 0) {
    return { type: 'flex', altText: 'นัดหมายทั้งหมด', contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [{ type: 'text', text: 'ยังไม่มีนัดหมายครับ 😊', size: 'sm', color: '#6b7280', align: 'center' }] },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [{ type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '+ เพิ่มนัดหมาย', text: 'เพิ่มนัด' } }] },
    }};
  }
  if (bubbles.length === 1) return { type: 'flex', altText: 'นัดหมายทั้งหมด', contents: bubbles[0] };
  return { type: 'flex', altText: 'นัดหมายทั้งหมด', contents: { type: 'carousel', contents: bubbles } };
}

// ── FLEX: Save Confirm ──
function flexSaveConfirm(title, date, time, headerText = '✅ บันทึกนัดหมายแล้วครับ', isPremium = false, notes = null) {
  const d = new Date(date + 'T00:00:00');
  const dayNames = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const dateLabel = `${dayNames[d.getDay()]}ที่ ${d.getDate()} ${monthNames[d.getMonth()]}`;

  const calUrl = `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(title)}&dates=${date.replace(/-/g,'')}T${time.replace(':','')}00/${date.replace(/-/g,'')}T${time.replace(':','')}00`;

  return {
    type: 'flex', altText: headerText,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: headerText, size: 'sm', weight: 'bold', color: '#06C755' },
          { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#ffffff', margin: 'xs', wrap: true },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
            contents: [
              { type: 'text', text: '📅', flex: 0, size: 'sm' },
              { type: 'text', text: dateLabel, flex: 1, size: 'sm', color: '#6b7280' },
            ]},
          { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
            contents: [
              { type: 'text', text: '⏰', flex: 0, size: 'sm' },
              { type: 'text', text: time, flex: 1, size: 'sm', color: '#6b7280' },
            ]},
          ...(notes ? [{ type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
            contents: [
              { type: 'text', text: '📝', flex: 0, size: 'sm' },
              { type: 'text', text: notes, flex: 1, size: 'sm', color: '#6b7280', wrap: true },
            ]}] : []),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          ...(isPremium ? [{ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '📆 Add to Calendar', uri: calUrl } }] : []),
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: Reminder ──
function flexReminder(apt, minutesBefore) {
  const label = minutesBefore >= 1440 ? `${minutesBefore/1440} วัน` : minutesBefore >= 60 ? `${minutesBefore/60} ชั่วโมง` : `${minutesBefore} นาที`;
  return {
    type: 'flex', altText: `⏰ แจ้งเตือน: ${apt.title} อีก ${label}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#FF6B35', paddingAll: '16px',
        contents: [
          { type: 'text', text: `⏰ อีก ${label}!`, size: 'xs', color: '#fff3ee', weight: 'bold' },
          { type: 'text', text: apt.title, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'text', text: `🕐 ${apt.start_time.slice(0,5)}${apt.location ? '\n📍 ' + apt.location : ''}`, size: 'sm', color: '#374151', wrap: true },
        ],
      },
    },
  };
}

// ── FLEX: Plan ──
function flexPlan(plan, expiresAt) {
  const planInfo = {
    free: { label: 'Free', color: '#94a3b8', price: 'ฟรีตลอด', bg: '#f1f5f9' },
    personal: { label: 'Personal', color: '#3b82f6', price: '฿30/เดือน', bg: '#eff6ff' },
    business: { label: 'Business', color: '#8b5cf6', price: '฿199/เดือน', bg: '#f5f3ff' },
  };
  const info = planInfo[plan] || planInfo.free;
  const exp = expiresAt ? `หมดอายุ: ${new Date(expiresAt).toLocaleDateString('th-TH')}` : '';
  const isExp = expiresAt && new Date(expiresAt) < new Date();

  return {
    type: 'flex', altText: `แพลนของฉัน: ${info.label}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '💳 แพลนของฉัน', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: info.label, size: 'xxl', weight: 'bold', color: info.color, margin: 'xs' },
          { type: 'text', text: info.price, size: 'sm', color: '#64748b' },
          ...(exp ? [{ type: 'text', text: isExp ? `⚠️ ${exp} (หมดแล้ว)` : exp, size: 'xs', color: isExp ? '#ef4444' : '#64748b', margin: 'xs' }] : []),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          ...(plan !== 'personal' && plan !== 'business' ? [{ type: 'button', style: 'primary', color: '#3b82f6', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Personal ฿30', text: 'อัปเกรด Personal' } }] : []),
          ...(plan !== 'business' ? [{ type: 'button', style: 'primary', color: '#8b5cf6', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Business ฿199', text: 'อัปเกรด Business' } }] : []),
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: Select Appointment (Carousel) ──
function flexSelectAppointment(apts, action) {
  const isDelete = action === 'ลบ';
  const icon = isDelete ? '🗑️' : '✏️';
  const headerColor = isDelete ? '#FF6B35' : '#06C755';
  const headerTitle = isDelete ? '🗑️ เลือกนัดที่จะลบ' : '✏️ เลือกนัดที่จะแก้ไข';
  const dayNames = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  const groups = {};
  for (const apt of apts) { if (!groups[apt.meeting_date]) groups[apt.meeting_date] = []; groups[apt.meeting_date].push(apt); }

  const bubbles = Object.entries(groups).slice(0, 12).map(([date, dayApts]) => {
    const d = new Date(date + 'T00:00:00');
    const dayLabel = `${dayNames[d.getDay()]}ที่ ${d.getDate()} ${monthNames[d.getMonth()]}`;
    const items = dayApts.map(apt => ({
      type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'xs', alignItems: 'center',
      action: { type: 'message', label: apt.title, text: `${action}:${apt.id}` },
      contents: [
        { type: 'box', layout: 'vertical', flex: 1,
          contents: [
            { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
            { type: 'text', text: `⏰ ${apt.start_time.slice(0,5)}${apt.location ? '  📍 ' + apt.location : ''}`, size: 'xs', color: '#6b7280', margin: 'xs' },
          ],
        },
        { type: 'text', text: icon, size: 'md', flex: 0 },
      ],
    }));
    return {
      type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '12px',
        contents: [
          { type: 'text', text: headerTitle, size: 'xxs', color: '#94a3b8' },
          { type: 'text', text: dayLabel, size: 'sm', weight: 'bold', color: headerColor },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'xs', contents: items },
    };
  });

  if (bubbles.length === 1) return { type: 'flex', altText: `เลือกนัดที่จะ${action}`, contents: bubbles[0] };
  return { type: 'flex', altText: `เลือกนัดที่จะ${action}`, contents: { type: 'carousel', contents: bubbles } };
}

// ── FLEX: Select Reminder Appointment ──
function flexSelectReminderApt(apts) {
  const items = apts.map(apt => ({
    type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'xs', alignItems: 'center',
    action: { type: 'message', label: apt.title, text: apt.title },
    contents: [
      { type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
          { type: 'text', text: `${apt.meeting_date} ⏰ ${apt.start_time.slice(0,5)}`, size: 'xs', color: '#6b7280', margin: 'xs' },
        ],
      },
      { type: 'text', text: '⏰', size: 'md', flex: 0 },
    ],
  }));
  return {
    type: 'flex', altText: 'เลือกนัดที่จะตั้งแจ้งเตือน',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [{ type: 'text', text: '⏰ เลือกนัดที่จะตั้งแจ้งเตือน', size: 'sm', weight: 'bold', color: '#06C755' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'xs', contents: items },
    },
  };
}

// ── FLEX: Set Reminder Time ──
function flexSetReminder(aptId, isBusiness) {
  const opts = [
    { label: '10 นาทีก่อน', mins: 10 }, { label: '30 นาทีก่อน', mins: 30 },
    { label: '1 ชั่วโมงก่อน', mins: 60 }, { label: '3 ชั่วโมงก่อน', mins: 180 },
    { label: '1 วันก่อน', mins: 1440 }, { label: '3 วันก่อน', mins: 4320 },
  ];
  const items = opts.map(o => ({
    type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'xs', alignItems: 'center',
    action: { type: 'message', label: o.label, text: `แจ้งเตือน${o.mins}` },
    contents: [
      { type: 'text', text: `⏰ ${o.label}`, size: 'sm', color: '#374151', flex: 1 },
      { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
    ],
  }));
  return {
    type: 'flex', altText: 'เลือกเวลาแจ้งเตือน',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: isBusiness ? '⏰ ตั้งแจ้งเตือน\nเพิ่มได้หลายช่วง' : '⏰ ตั้งแจ้งเตือน', size: 'sm', weight: 'bold', color: '#06C755', wrap: true },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'xs', contents: items },
    },
  };
}

// ── FLEX: Contact ──
function flexContact() {
  return {
    type: 'flex', altText: 'ติดต่อเรา',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '💬 ติดต่อเรา', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'แจ้งปัญหาการใช้งาน', size: 'lg', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'text', text: 'เลือกหัวข้อที่ต้องการแจ้งครับ', size: 'sm', color: '#374151', weight: 'bold' },
          ...[['🐛 พบปัญหาการใช้งาน','Bot ไม่ตอบ หรือตอบผิด','แจ้งปัญหาการใช้งาน'],['💡 แนะนำฟีเจอร์','อยากให้เพิ่มความสามารถ','แนะนำฟีเจอร์'],['💳 สอบถามแผนและราคา','Free / Personal / Business','สอบถามแผนและราคา'],['❓ อื่นๆ','ติดต่อทีมงานโดยตรง','อื่นๆ']].map(([icon, sub, text]) => ({
            type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'xs',
            action: { type: 'message', label: icon, text },
            contents: [
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: icon, size: 'sm', weight: 'bold', color: '#111111' },
                { type: 'text', text: sub, size: 'xs', color: '#6b7280', margin: 'xs' },
              ]},
              { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
            ],
          })),
        ],
      },
    },
  };
}

// ── FLEX: Team Menu ──
function flexTeamMenu(ownTeams, memberTeams) {
  const items = [];
  for (const team of ownTeams) {
    items.push({
      type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
      contents: [
        { type: 'box', layout: 'horizontal', alignItems: 'center',
          contents: [
            { type: 'text', text: '👑', size: 'md', flex: 0 },
            { type: 'box', layout: 'vertical', flex: 1, paddingStart: '8px',
              contents: [
                { type: 'text', text: team.name, size: 'sm', weight: 'bold', color: '#14532d' },
                { type: 'text', text: 'เจ้าของทีม', size: 'xs', color: '#16a34a' },
              ]},
          ]},
        { type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm',
          contents: [
            { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '🔗 Link เชิญ', text: `link:${team.name}` } },
            { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '👥 ดูสมาชิก', text: `สมาชิก:${team.name}` } },
          ]},
      ],
    });
  }
  for (const m of memberTeams) {
    if (!m.teams) continue;
    items.push({
      type: 'box', layout: 'horizontal', backgroundColor: '#f0f9ff', cornerRadius: '10px', paddingAll: '12px', margin: 'sm', alignItems: 'center',
      contents: [
        { type: 'text', text: '👥', size: 'md', flex: 0 },
        { type: 'box', layout: 'vertical', flex: 1, paddingStart: '8px',
          contents: [
            { type: 'text', text: m.teams.name, size: 'sm', weight: 'bold', color: '#1e40af' },
            { type: 'text', text: 'สมาชิก', size: 'xs', color: '#3b82f6' },
          ]},
      ],
    });
  }
  if (items.length === 0) {
    items.push({ type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '16px', margin: 'sm',
      contents: [{ type: 'text', text: 'ยังไม่มีทีมครับ\nกด "สร้างทีม" เพื่อเริ่มต้น', size: 'sm', color: '#6b7280', align: 'center', wrap: true }],
    });
  }
  return {
    type: 'flex', altText: '👥 จัดการทีม',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '👥 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'ทีมของฉัน', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{ type: 'button', style: 'primary', color: '#8b5cf6', height: 'sm', action: { type: 'message', label: '+ สร้างทีมใหม่', text: 'สร้างทีม' } }],
      },
    },
  };
}

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));
