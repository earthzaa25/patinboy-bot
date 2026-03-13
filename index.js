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

async function parseAppointmentWithClaude(text) {
  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const prompt = `วันนี้คือ ${todayStr} (พรุ่งนี้คือ ${tomorrowStr})

ข้อความ: "${text}"

วิเคราะห์ข้อความนี้และแปลงเป็น JSON นัดหมาย ตอบเฉพาะ JSON เท่านั้น ไม่ต้องมีคำอธิบาย:
{"isAppointment":true/false,"title":"ชื่อนัดหมาย","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null"}

กฎ: วันนี้=${todayStr}, พรุ่งนี้=${tomorrowStr}, บ่ายโมง=13:00, บ่ายสอง=14:00, บ่ายสาม=15:00, ทุ่มหนึ่ง=19:00, สองทุ่ม=20:00, สามทุ่ม=21:00, เที่ยง=12:00, 1300=13:00`;

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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  if (msg === 'สวัสดี' || msg === 'หวัดดี') return reply(event, [flexWelcome()]);
  if (msg === 'เมนู') return reply(event, [flexMenu()]);
  if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') {
    const apts = await getTodayAppointments(userId);
    return reply(event, [flexSchedule(apts)]);
  }

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

async function saveAndReply(event, userId, data) {
  const { title, date, time, location } = data;
  const startTime = time.includes(':') ? `${time}:00` : time;

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

async function getTodayAppointments(userId) {
  const today = formatDate(new Date());
  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('user_id', userId).eq('meeting_date', today)
    .order('start_time', { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

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
            action: { type: 'message', label: '➕ เพิ่มนัดหมาย', text: 'เพิ่มนัด' } },
        ]},
    },
  };
}

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
          { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '8px',
            action: { type: 'message', label: 'กำหนดการ', text: 'กำหนดการ' },
            contents: [
              { type: 'text', text: '🗓', size: 'xl', flex: 0 },
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: 'ดูกำหนดการวันนี้', size: 'sm', weight: 'bold', color: '#111' },
                { type: 'text', text: 'นัดหมายทั้งหมดของวันนี้', size: 'xs', color: '#9ca3af' },
              ]},
              { type: 'text', text: '›', size: 'lg', color: '#d1d5db' },
            ]},
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '8px',
            action: { type: 'message', label: 'เพิ่มนัด', text: 'เพิ่มนัด' },
            contents: [
              { type: 'text', text: '➕', size: 'xl', flex: 0 },
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: 'เพิ่มนัดหมายใหม่', size: 'sm', weight: 'bold', color: '#111' },
                { type: 'text', text: 'บอกได้เลย เช่น "พรุ่งนี้ บ่ายโมง ประชุม"', size: 'xs', color: '#9ca3af', wrap: true },
              ]},
              { type: 'text', text: '›', size: 'lg', color: '#d1d5db' },
            ]},
        ]},
    },
  };
}

function flexSaveConfirm(title, date, time) {
  return {
    type: 'flex', altText: `✅ บันทึกนัด: ${title}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          { type: 'text', text: '✅ บันทึกนัดหมายแล้ว!', size: 'md', weight: 'bold', color: '#06C755' },
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '📋', flex: 0, size: 'sm' }, { type: 'text', text: title, weight: 'bold', flex: 1, wrap: true, size: 'sm', color: '#111' }]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '📅', flex: 0, size: 'sm' }, { type: 'text', text: date, flex: 1, size: 'sm', color: '#555' }]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [{ type: 'text', text: '⏰', flex: 0, size: 'sm' }, { type: 'text', text: time, flex: 1, size: 'sm', color: '#555' }]},
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

function getMinuteDiff(targetTime, nowTime) {
  const [th, tm] = targetTime.split(':').map(Number);
  const [nh, nm] = nowTime.split(':').map(Number);
  return (th * 60 + tm) - (nh * 60 + nm);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));