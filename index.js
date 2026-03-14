if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

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

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: 'ok' }))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

function reply(event, messages) {
  return client.replyMessage({ replyToken: event.replyToken, messages });
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── แจ้งเตือนอัตโนมัติทุก 1 นาที ──
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const todayStr = formatDate(now);
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${h}:${m}:00`;

  // หานัดที่จะถึงในอีก 30 นาที
  const target = new Date(now.getTime() + 30 * 60 * 1000);
  const th = String(target.getHours()).padStart(2, '0');
  const tm = String(target.getMinutes()).padStart(2, '0');
  const targetTime = `${th}:${tm}:00`;

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('meeting_date', todayStr)
    .eq('start_time', targetTime)
    .eq('reminded', false);

  if (error) { console.error('Cron error:', error); return; }
  if (!data || data.length === 0) return;

  for (const apt of data) {
    try {
      await client.pushMessage({
        to: apt.user_id,
        messages: [flexReminder(apt)],
      });
      await supabase.from('appointments').update({ reminded: true }).eq('id', apt.id);
      console.log(`✅ แจ้งเตือน: ${apt.title} → ${apt.user_id}`);
    } catch (err) {
      console.error('Push error:', err.message);
    }
  }
});

// ── Claude AI วิเคราะห์ข้อความ ──
async function parseAppointmentWithClaude(text) {
  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const prompt = `วันนี้คือ ${todayStr} พรุ่งนี้คือ ${tomorrowStr}

ข้อความ: "${text}"

ตอบเฉพาะ JSON เท่านั้น:
{"isAppointment":true/false,"title":"ชื่อนัดหมาย","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null"}

กฎ: วันนี้=${todayStr}, พรุ่งนี้=${tomorrowStr}, บ่ายโมง=13:00, บ่ายสอง=14:00, บ่ายสาม=15:00, บ่ายสี่=16:00, บ่ายห้า=17:00, ทุ่มหนึ่ง=19:00, สองทุ่ม=20:00, สามทุ่ม=21:00, เที่ยง=12:00, 1300=13:00, ถ้าไม่เกี่ยวกับนัดหมายให้ isAppointment=false`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const content = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(content);
  } catch (err) {
    console.error('Claude API error:', err);
    return null;
  }
}

// ── เก็บ state ลบ/แก้ไข ──
const userState = {};

// ── Handler หลัก ──
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  // ตรวจสอบปุ่มลบ/แก้ไขก่อนเสมอ
  if (msg.startsWith('ลบ:')) {
    delete userState[userId];
    const id = msg.replace('ลบ:', '');
    return await deleteAppointment(event, userId, id);
  }
  if (msg.startsWith('แก้ไข:')) {
    delete userState[userId];
    const id = msg.replace('แก้ไข:', '');
    const { data } = await supabase.from('appointments').select('*').eq('id', id).single();
    if (data) {
      userState[userId] = { step: 'editing', apt: data };
      return reply(event, [{ type: 'text', text: `✏️ แก้ไข "${data.title}"

บอกข้อมูลใหม่ได้เลยครับ เช่น
"พรุ่งนี้ บ่ายสอง ประชุมทีม"` }]);
    }
  }

  // จัดการ state
  if (userState[userId]) return handleState(event, userId, msg);

  if (msg === 'สวัสดี' || msg === 'หวัดดี') return reply(event, [flexWelcome()]);
  if (msg === 'เมนู') return reply(event, [flexMenu()]);
  if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') {
    const apts = await getTodayAppointments(userId);
    return reply(event, [flexSchedule(apts)]);
  }
  if (msg === 'นัดหมายทั้งหมด') {
    const apts = await getAllAppointments(userId);
    return reply(event, [flexAllSchedule(apts)]);
  }
  if (msg === 'ลบนัดหมาย') {
    const apts = await getTodayAppointments(userId);
    if (apts.length === 0) return reply(event, [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊' }]);
    userState[userId] = { step: 'selectDelete', apts };
    return reply(event, [flexSelectAppointment(apts, 'ลบ')]);
  }
  if (msg === 'แก้ไขนัดหมาย') {
    const apts = await getTodayAppointments(userId);
    if (apts.length === 0) return reply(event, [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊' }]);
    userState[userId] = { step: 'selectEdit', apts };
    return reply(event, [flexSelectAppointment(apts, 'แก้ไข')]);
  }

  // ตรวจสอบว่าเลือกลบ/แก้ไขจากปุ่ม
  if (msg.startsWith('ลบ:')) {
    const id = msg.replace('ลบ:', '');
    return await deleteAppointment(event, userId, id);
  }
  if (msg.startsWith('แก้ไข:')) {
    const id = msg.replace('แก้ไข:', '');
    const { data } = await supabase.from('appointments').select('*').eq('id', id).single();
    if (data) {
      userState[userId] = { step: 'editing', apt: data };
      return reply(event, [{ type: 'text', text: `✏️ แก้ไข "${data.title}"\n\nบอกข้อมูลใหม่ได้เลยครับ เช่น\n"พรุ่งนี้ บ่ายสอง ประชุมทีม"` }]);
    }
  }

  // Claude AI วิเคราะห์
  const parsed = await parseAppointmentWithClaude(msg);
  console.log('Claude parsed:', JSON.stringify(parsed));

  if (!parsed || !parsed.isAppointment) {
    return reply(event, [{
      type: 'text',
      text: 'พิมพ์ "เมนู" เพื่อดูคำสั่งครับ 😊\n\nหรือบอกนัดหมายได้เลย เช่น\n"พรุ่งนี้ บ่ายโมง ประชุมทีม"',
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
        { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    }]);
  }

  if (!parsed.date) {
    return reply(event, [{
      type: 'text', text: `📅 "${parsed.title}" — วันไหนครับ?`,
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: 'วันนี้', text: `${parsed.title} วันนี้ ${parsed.time || ''}`.trim() } },
        { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: `${parsed.title} พรุ่งนี้ ${parsed.time || ''}`.trim() } },
      ]},
    }]);
  }

  if (!parsed.time) {
    return reply(event, [{ type: 'text', text: `⏰ "${parsed.title}" — กี่โมงครับ?\n\nเช่น: 14:00 / บ่ายสอง / 1400` }]);
  }

  return await saveAndReply(event, userId, parsed);
}

// ── จัดการ State ──
async function handleState(event, userId, msg) {
  const state = userState[userId];

  if (state.step === 'editing') {
    const parsed = await parseAppointmentWithClaude(msg);
    if (!parsed || !parsed.isAppointment) {
      delete userState[userId];
      return reply(event, [{ type: 'text', text: '❌ ไม่เข้าใจครับ ยกเลิกการแก้ไขแล้ว' }]);
    }
    const updateData = {};
    if (parsed.title) updateData.title = parsed.title;
    if (parsed.date) updateData.meeting_date = parsed.date;
    if (parsed.time) updateData.start_time = `${parsed.time}:00`;
    if (parsed.location) updateData.location = parsed.location;
    updateData.reminded = false;

    const { error } = await supabase.from('appointments').update(updateData).eq('id', state.apt.id);
    delete userState[userId];

    if (error) return reply(event, [{ type: 'text', text: `❌ แก้ไขไม่สำเร็จ: ${error.message}` }]);
    return reply(event, [flexSaveConfirm(
      parsed.title || state.apt.title,
      parsed.date || state.apt.meeting_date,
      parsed.time || state.apt.start_time.slice(0,5),
      '✏️ แก้ไขนัดหมายแล้ว!'
    )]);
  }
}

// ── ลบนัดหมาย ──
async function deleteAppointment(event, userId, id) {
  const { data } = await supabase.from('appointments').select('title').eq('id', id).single();
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  delete userState[userId];
  if (error) return reply(event, [{ type: 'text', text: `❌ ลบไม่สำเร็จ: ${error.message}` }]);
  return reply(event, [{
    type: 'text', text: `🗑️ ลบ "${data?.title || 'นัดหมาย'}" แล้วครับ`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ]},
  }]);
}

// ── บันทึกลง Supabase ──
async function saveAndReply(event, userId, data) {
  const { title, date, time, location } = data;
  const startTime = `${time}:00`;

  const { error } = await supabase.from('appointments').insert({
    user_id: userId, title, meeting_date: date,
    start_time: startTime, end_time: null, location: location || null,
  });

  if (error) {
    console.error('Supabase error:', error);
    return reply(event, [{ type: 'text', text: `❌ บันทึกไม่สำเร็จครับ\nError: ${error.message}` }]);
  }

  return reply(event, [flexSaveConfirm(title, date, time)]);
}

// ── ดึงนัดวันนี้ ──
async function getTodayAppointments(userId) {
  const today = formatDate(new Date());
  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('user_id', userId).eq('meeting_date', today)
    .order('start_time', { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

// ── ดึงนัดทั้งหมด ──
async function getAllAppointments(userId) {
  const today = formatDate(new Date());
  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('user_id', userId)
    .gte('meeting_date', today)
    .order('meeting_date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(20);
  if (error) { console.error(error); return []; }
  return data || [];
}

// ── Flex: Reminder ──
function flexReminder(apt) {
  return {
    type: 'flex', altText: `⏰ แจ้งเตือน: ${apt.title} อีก 30 นาที`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#FF6B35', paddingAll: '14px',
        contents: [
          { type: 'text', text: '⏰ แจ้งเตือนนัดหมาย', size: 'xs', color: '#ffffff', weight: 'bold' },
          { type: 'text', text: 'อีก 30 นาที!', size: 'xl', weight: 'bold', color: '#ffffff' },
        ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'text', text: apt.title, size: 'lg', weight: 'bold', color: '#111111', wrap: true },
          { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
            contents: [
              { type: 'text', text: '📅', flex: 0, size: 'sm' },
              { type: 'text', text: apt.meeting_date, flex: 1, size: 'sm', color: '#555555' },
            ]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '⏰', flex: 0, size: 'sm' },
              { type: 'text', text: apt.start_time.slice(0,5), flex: 1, size: 'sm', color: '#555555' },
            ]},
          apt.location ? { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '📍', flex: 0, size: 'sm' },
              { type: 'text', text: apt.location, flex: 1, size: 'sm', color: '#555555', wrap: true },
            ]} : { type: 'filler' },
        ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm',
            action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
        ]},
    },
  };
}

// ── Flex: Welcome ──
function flexWelcome() {
  return {
    type: 'flex', altText: 'สวัสดีครับ! ผม ปฏิทินBoy',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', paddingAll: '16px',
        contents: [
          { type: 'text', text: '👋 ยินดีต้อนรับ', size: 'xs', color: '#9ca3af', weight: 'bold' },
          { type: 'text', text: 'สวัสดีครับ! ผม ปฏิทินBoy', size: 'md', weight: 'bold', color: '#374151', wrap: true },
          { type: 'text', text: 'ใช้ได้ฟรีเลย!', size: 'sm', color: '#6b7280' },
        ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '8px', paddingAll: '10px',
            contents: [{ type: 'text', text: '📅 บันทึกนัดหมายได้ไม่จำกัด ฟรีตลอด', size: 'sm', color: '#166534', weight: 'bold', wrap: true }] },
          { type: 'separator' },
          { type: 'text', text: 'บอกนัดได้เลยครับ เช่น\n"พรุ่งนี้ บ่ายโมง ประชุมทีม"', size: 'sm', color: '#374151', wrap: true },
        ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm',
            action: { type: 'message', label: '📅 ดูกำหนดการวันนี้', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ]},
    },
  };
}

// ── Flex: Menu ──
function flexMenu() {
  return {
    type: 'flex', altText: 'ปฏิทินBoy เมนูหลัก',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'md', weight: 'bold', color: '#374151' },
          { type: 'text', text: 'เมนูหลัก', size: 'sm', color: '#9ca3af' },
        ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          menuItem('🗓', 'ดูกำหนดการวันนี้', 'นัดหมายทั้งหมดของวันนี้', 'กำหนดการ'),
          { type: 'separator' },
          menuItem('📆', 'นัดหมายทั้งหมด', 'ดูนัดที่กำลังจะมาถึง', 'นัดหมายทั้งหมด'),
          { type: 'separator' },
          menuItem('➕', 'เพิ่มนัดหมายใหม่', 'บอกได้เลย เช่น "พรุ่งนี้ บ่ายโมง ประชุม"', 'เพิ่มนัด'),
          { type: 'separator' },
          menuItem('✏️', 'แก้ไขนัดหมาย', 'แก้ไขนัดหมายวันนี้', 'แก้ไขนัดหมาย'),
          { type: 'separator' },
          menuItem('🗑️', 'ลบนัดหมาย', 'ลบนัดหมายวันนี้', 'ลบนัดหมาย'),
        ]},
    },
  };
}

function menuItem(icon, title, subtitle, action) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '8px',
    action: { type: 'message', label: title, text: action },
    contents: [
      { type: 'text', text: icon, size: 'xl', flex: 0 },
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        { type: 'text', text: title, size: 'sm', weight: 'bold', color: '#111111' },
        { type: 'text', text: subtitle, size: 'xs', color: '#9ca3af', wrap: true },
      ]},
      { type: 'text', text: '›', size: 'lg', color: '#d1d5db' },
    ],
  };
}

// ── Flex: Save Confirm ──
function flexSaveConfirm(title, date, time, headerText = '✅ บันทึกนัดหมายแล้ว!') {
  return {
    type: 'flex', altText: `✅ บันทึกนัด: ${title}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          { type: 'text', text: headerText, size: 'md', weight: 'bold', color: '#06C755' },
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '📋', flex: 0, size: 'sm' }, { type: 'text', text: title, weight: 'bold', flex: 1, wrap: true, size: 'sm', color: '#111111' }]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '📅', flex: 0, size: 'sm' }, { type: 'text', text: date, flex: 1, size: 'sm', color: '#555555' }]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '⏰', flex: 0, size: 'sm' }, { type: 'text', text: time, flex: 1, size: 'sm', color: '#555555' }]},
        ]},
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1,
            action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'message', label: '➕ เพิ่มอีก', text: 'เพิ่มนัด' } },
        ]},
    },
  };
}

// ── Flex: Select Appointment ──
function flexSelectAppointment(apts, action) {
  const items = apts.map(apt => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '8px',
    action: { type: 'message', label: apt.title, text: `${action}:${apt.id}` },
    contents: [
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
        { type: 'text', text: `${apt.start_time.slice(0,5)} ${apt.location || ''}`.trim(), size: 'xs', color: '#9ca3af' },
      ]},
      { type: 'text', text: action === 'ลบ' ? '🗑️' : '✏️', size: 'lg', flex: 0 },
    ],
  }));

  return {
    type: 'flex', altText: `เลือกนัดที่จะ${action}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', paddingAll: '16px',
        contents: [{ type: 'text', text: `เลือกนัดที่จะ${action}ครับ`, size: 'md', weight: 'bold', color: '#374151' }]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: items },
    },
  };
}

// ── Flex: Schedule Today ──
function flexSchedule(appointments) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const now = today.toTimeString().slice(0, 5);

  const items = appointments.length > 0 ? appointments.map(apt => {
    const aptTime = apt.start_time.slice(0, 5);
    const isPast = aptTime < now;
    const diff = getMinuteDiff(aptTime, now);
    const isUpcoming = !isPast && diff <= 60;
    return {
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingBottom: '8px',
      contents: [
        { type: 'box', layout: 'vertical', width: '42px', alignItems: 'center',
          contents: [
            { type: 'text', text: aptTime, size: 'xs', weight: 'bold', color: isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#111111' },
            { type: 'box', width: '8px', height: '8px', cornerRadius: '4px', backgroundColor: isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#1a73e8', margin: 'sm', layout: 'vertical', contents: [] },
          ]},
        { type: 'box', layout: 'vertical', flex: 1, backgroundColor: isPast ? '#f5f5f5' : isUpcoming ? '#fff9f7' : '#f7faff', cornerRadius: '8px', paddingAll: '8px',
          contents: [
            { type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: isPast ? '#999999' : '#111111', flex: 1, wrap: true },
                isUpcoming ? { type: 'text', text: `อีก ${diff} นาที`, size: 'xs', color: '#ffffff', backgroundColor: '#FF6B35', cornerRadius: '20px', paddingAll: '3px' } : { type: 'filler' },
              ]},
            apt.location ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#999999', margin: 'xs' } : { type: 'filler' },
          ]},
      ],
    };
  }) : [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊', size: 'sm', color: '#999999', align: 'center', margin: 'lg' }];

  return {
    type: 'flex', altText: `กำหนดการวันนี้ — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1a1a2e', paddingAll: '14px',
        contents: [
          { type: 'text', text: dateStr, size: 'xs', color: '#aaaaaa', weight: 'bold' },
          { type: 'text', text: 'กำหนดการวันนี้', size: 'lg', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: `● ${appointments.length} รายการ`, size: 'xs', color: '#06C755', margin: 'sm' },
        ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'none', contents: items },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ]},
    },
  };
}

// ── Flex: All Schedule ──
function flexAllSchedule(appointments) {
  const items = appointments.length > 0 ? appointments.map(apt => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingBottom: '8px',
    contents: [
      { type: 'box', layout: 'vertical', width: '50px', alignItems: 'center',
        contents: [
          { type: 'text', text: apt.meeting_date.slice(5), size: 'xs', weight: 'bold', color: '#1a73e8' },
          { type: 'text', text: apt.start_time.slice(0,5), size: 'xs', color: '#555555' },
        ]},
      { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#f7faff', cornerRadius: '8px', paddingAll: '8px',
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
          apt.location ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#999999', margin: 'xs' } : { type: 'filler' },
        ]},
    ],
  })) : [{ type: 'text', text: 'ไม่มีนัดหมายที่กำลังจะมาถึงครับ 😊', size: 'sm', color: '#999999', align: 'center', margin: 'lg' }];

  return {
    type: 'flex', altText: `นัดหมายทั้งหมด — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1a1a2e', paddingAll: '14px',
        contents: [
          { type: 'text', text: 'นัดหมายที่กำลังจะมาถึง', size: 'lg', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: `● ${appointments.length} รายการ`, size: 'xs', color: '#06C755', margin: 'sm' },
        ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'none', contents: items },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ]},
    },
  };
}

function getMinuteDiff(targetTime, nowTime) {
  const [th, tm] = targetTime.split(':').map(Number);
  const [nh, nm] = nowTime.split(':').map(Number);
  return (th * 60 + tm) - (nh * 60 + nm);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));