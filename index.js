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

// เก็บ state การสนทนา (in-memory)
const userState = {};

// ── แปลงวันภาษาไทย/ตัวเลข → YYYY-MM-DD ──
function parseDate(text) {
  const today = new Date();
  const t = text;
  if (t.includes('วันนี้')) return formatDate(today);
  if (t.includes('พรุ่งนี้')) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return formatDate(d);
  }
  if (t.includes('มะรืน')) {
    const d = new Date(today); d.setDate(d.getDate() + 2); return formatDate(d);
  }
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (slash) {
    const year = slash[3] || today.getFullYear();
    return `${year}-${slash[2].padStart(2,'0')}-${slash[1].padStart(2,'0')}`;
  }
  return null;
}

// ── แปลงเวลาภาษาไทย/ตัวเลข → HH:MM ──
function parseTime(text) {
  const t = text;
  const timeMap = {
    'บ่ายโมง': '13:00', 'บ่ายสอง': '14:00', 'บ่ายสาม': '15:00',
    'บ่ายสี่': '16:00', 'บ่ายห้า': '17:00',
    'หกโมงเช้า': '06:00', 'เจ็ดโมงเช้า': '07:00', 'แปดโมงเช้า': '08:00',
    'เก้าโมงเช้า': '09:00', 'สิบโมงเช้า': '10:00', 'สิบเอ็ดโมง': '11:00',
    'เที่ยง': '12:00', 'ทุ่มหนึ่ง': '19:00', 'สองทุ่ม': '20:00',
    'สามทุ่ม': '21:00', 'สี่ทุ่ม': '22:00', 'ห้าทุ่ม': '23:00',
    'หกโมงเย็น': '18:00', 'เจ็ดโมงเย็น': '19:00', 'แปดโมงเย็น': '20:00',
    'เก้าโมงเย็น': '21:00',
  };
  for (const [k, v] of Object.entries(timeMap)) {
    if (t.includes(k)) return v;
  }
  const num4 = t.match(/\b(\d{4})\b/);
  if (num4 && parseInt(num4[1]) <= 2359) return `${num4[1].slice(0,2)}:${num4[1].slice(2)}`;
  const dotColon = t.match(/\b(\d{1,2})[.:](\d{2})\b/);
  if (dotColon) return `${dotColon[1].padStart(2,'0')}:${dotColon[2]}`;
  const single = t.match(/\b([1-9])\b/);
  if (single) {
    const h = parseInt(single[1]);
    return h <= 6 ? `${h + 12}:00` : `${String(h).padStart(2,'0')}:00`;
  }
  return null;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function reply(event, messages) {
  return client.replyMessage({ replyToken: event.replyToken, messages });
}

// ── Handler หลัก ──
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  if (userState[userId]) return handleAddFlow(event, userId, msg);

  if (msg === 'สวัสดี' || msg === 'หวัดดี') {
    return reply(event, [flexWelcome()]);
  } else if (msg === 'เมนู') {
    return reply(event, [flexMenu()]);
  } else if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') {
    const apts = await getTodayAppointments(userId);
    return reply(event, [flexSchedule(apts)]);
  } else if (msg === 'เพิ่มนัด') {
    userState[userId] = { step: 'smart' };
    return reply(event, [{
      type: 'text',
      text: '📅 บอกนัดหมายได้เลยครับ\n\nเช่น:\n• พรุ่งนี้ บ่ายโมง ประชุมทีม\n• 15/3 14:00 นัดหมอ\n• วันนี้ 3 ทุ่ม กินข้าว',
    }]);
  } else {
    return reply(event, [{
      type: 'text',
      text: 'พิมพ์ "เมนู" เพื่อดูคำสั่งครับ 😊',
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
        { type: 'action', action: { type: 'message', label: '➕ เพิ่มนัด', text: 'เพิ่มนัด' } },
        { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    }]);
  }
}

// ── Flow เพิ่มนัดทีละขั้น ──
async function handleAddFlow(event, userId, msg) {
  const state = userState[userId];

  if (state.step === 'smart') {
    const date = parseDate(msg);
    const time = parseTime(msg);
    let title = msg
      .replace(/พรุ่งนี้|วันนี้|มะรืน/g, '')
      .replace(/บ่ายโมง|บ่ายสอง|บ่ายสาม|บ่ายสี่|บ่ายห้า|เที่ยง/g, '')
      .replace(/สามทุ่ม|สองทุ่ม|ทุ่มหนึ่ง|สี่ทุ่ม|ห้าทุ่ม/g, '')
      .replace(/หกโมงเช้า|เจ็ดโมงเช้า|แปดโมงเช้า|เก้าโมงเช้า|สิบโมงเช้า|สิบเอ็ดโมง/g, '')
      .replace(/หกโมงเย็น|เจ็ดโมงเย็น|แปดโมงเย็น|เก้าโมงเย็น/g, '')
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\d{1,2}\/\d{1,2}(\/\d{4})?/g, '')
      .replace(/\b\d{4}\b/g, '')
      .replace(/\b\d{1,2}[.:]\d{2}\b/g, '')
      .replace(/\s+/g, ' ').trim();

    if (!date) {
      userState[userId] = { step: 'askDate', time, title: title || msg };
      return reply(event, [{
        type: 'text', text: '📅 วันไหนครับ?',
        quickReply: { items: [
          { type: 'action', action: { type: 'message', label: 'วันนี้', text: 'วันนี้' } },
          { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: 'พรุ่งนี้' } },
        ]},
      }]);
    }
    if (!time) {
      userState[userId] = { step: 'askTime', date, title: title || msg };
      return reply(event, [{ type: 'text', text: '⏰ กี่โมงครับ?\n\nเช่น: 14:00 / บ่ายสอง / 1400' }]);
    }
    if (!title) {
      userState[userId] = { step: 'askTitle', date, time };
      return reply(event, [{ type: 'text', text: '📋 ชื่อนัดหมายคืออะไรครับ?' }]);
    }
    return await saveAndReply(event, userId, { title, date, time });

  } else if (state.step === 'askDate') {
    const date = parseDate(msg) || msg;
    if (!state.time) {
      userState[userId] = { ...state, step: 'askTime', date };
      return reply(event, [{ type: 'text', text: '⏰ กี่โมงครับ?' }]);
    }
    return await saveAndReply(event, userId, { ...state, date });

  } else if (state.step === 'askTime') {
    const time = parseTime(msg) || msg;
    return await saveAndReply(event, userId, { ...state, time });

  } else if (state.step === 'askTitle') {
    return await saveAndReply(event, userId, { ...state, title: msg });
  }
}

// ── บันทึกลง Supabase ──
async function saveAndReply(event, userId, data) {
  delete userState[userId];
  const { title, date, time } = data;
  const startTime = time.includes(':') ? `${time}:00` : time;

  const { error } = await supabase.from('appointments').insert({
    user_id: userId,
    title,
    meeting_date: date,
    start_time: startTime,
    end_time: null,
    location: null,
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

// ── Flex Messages ──

function flexWelcome() {
  return {
    type: 'flex',
    altText: 'สวัสดีครับ! ผม ปฏิทินBoy',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', paddingAll: '16px',
        contents: [
          { type: 'text', text: '👋 ยินดีต้อนรับ', size: 'xs', color: '#9ca3af', weight: 'bold' },
          { type: 'text', text: 'สวัสดีครับ! ผม ปฏิทินBoy', size: 'md', weight: 'bold', color: '#374151', wrap: true },
          { type: 'text', text: 'ใช้ได้ฟรีเลย!', size: 'sm', color: '#6b7280' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '8px', paddingAll: '10px',
            contents: [{ type: 'text', text: '📅 บันทึกนัดหมายได้ไม่จำกัด ฟรีตลอด', size: 'sm', color: '#166534', weight: 'bold', wrap: true }] },
          { type: 'separator' },
          { type: 'text', text: 'บอกนัดได้เลยครับ เช่น\n"พรุ่งนี้ บ่ายโมง ประชุมทีม"', size: 'sm', color: '#374151', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm',
            action: { type: 'message', label: '📅 ดูกำหนดการวันนี้', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '➕ เพิ่มนัดหมาย', text: 'เพิ่มนัด' } },
        ],
      },
    },
  };
}

function flexMenu() {
  return {
    type: 'flex',
    altText: 'ปฏิทินBoy เมนูหลัก',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'md', weight: 'bold', color: '#374151' },
          { type: 'text', text: 'เมนูหลัก', size: 'sm', color: '#9ca3af' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
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
            ],
          },
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
            ],
          },
        ],
      },
    },
  };
}

function flexSaveConfirm(title, date, time) {
  return {
    type: 'flex',
    altText: `✅ บันทึกนัด: ${title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          { type: 'text', text: '✅ บันทึกนัดหมายแล้ว!', size: 'md', weight: 'bold', color: '#06C755' },
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '📋', flex: 0, size: 'sm' },
              { type: 'text', text: title, weight: 'bold', flex: 1, wrap: true, size: 'sm', color: '#111' },
            ]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '📅', flex: 0, size: 'sm' },
              { type: 'text', text: date, flex: 1, size: 'sm', color: '#555' },
            ]},
          { type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '⏰', flex: 0, size: 'sm' },
              { type: 'text', text: time, flex: 1, size: 'sm', color: '#555' },
            ]},
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1,
            action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'message', label: '➕ เพิ่มอีก', text: 'เพิ่มนัด' } },
        ],
      },
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
        {
          type: 'box', layout: 'vertical', width: '42px', alignItems: 'center',
          contents: [
            { type: 'text', text: aptTime, size: 'xs', weight: 'bold',
              color: isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#111111' },
            { type: 'box', width: '8px', height: '8px', cornerRadius: '4px',
              backgroundColor: isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#1a73e8',
              margin: 'sm', layout: 'vertical', contents: [] },
          ],
        },
        {
          type: 'box', layout: 'vertical', flex: 1,
          backgroundColor: isPast ? '#f5f5f5' : isUpcoming ? '#fff9f7' : '#f7faff',
          cornerRadius: '8px', paddingAll: '8px',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: apt.title, size: 'sm', weight: 'bold',
                  color: isPast ? '#999' : '#111', flex: 1, wrap: true },
                isUpcoming
                  ? { type: 'text', text: `อีก ${diff} นาที`, size: 'xs', color: '#fff',
                      backgroundColor: '#FF6B35', cornerRadius: '20px', paddingAll: '3px' }
                  : { type: 'filler' },
              ],
            },
            apt.location
              ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#999', margin: 'xs' }
              : { type: 'filler' },
          ],
        },
      ],
    };
  }) : [{
    type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊',
    size: 'sm', color: '#999', align: 'center', margin: 'lg',
  }];

  return {
    type: 'flex',
    altText: `กำหนดการวันนี้ — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1a1a2e', paddingAll: '14px',
        contents: [
          { type: 'text', text: dateStr, size: 'xs', color: '#aaaaaa', weight: 'bold' },
          { type: 'text', text: 'กำหนดการวันนี้', size: 'lg', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: `● ${appointments.length} รายการ`, size: 'xs', color: '#06C755', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'none',
        contents: items,
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1,
            action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

function getMinuteDiff(targetTime, nowTime) {
  const [th, tm] = targetTime.split(':').map(Number);
  const [nh, nm] = nowTime.split(':').map(Number);
  return (th * 60 + tm) - (nh * 60 + nm);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`);
});
