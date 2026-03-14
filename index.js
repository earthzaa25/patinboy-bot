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

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const todayStr = formatDate(now);
  const target = new Date(now.getTime() + 30 * 60 * 1000);
  const targetTime = `${String(target.getHours()).padStart(2,'0')}:${String(target.getMinutes()).padStart(2,'0')}:00`;
  const { data, error } = await supabase.from('appointments').select('*')
    .eq('meeting_date', todayStr).eq('start_time', targetTime).eq('reminded', false);
  if (error || !data || data.length === 0) return;
  for (const apt of data) {
    try {
      await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt)] });
      await supabase.from('appointments').update({ reminded: true }).eq('id', apt.id);
    } catch (err) { console.error('Push error:', err.message); }
  }
});

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
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    return JSON.parse(data.content[0].text.trim().replace(/```json|```/g, '').trim());
  } catch (err) { console.error('Claude API error:', err); return null; }
}

const userState = {};

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const msg = event.message.text.trim();
  console.log('USER ID:', userId);

  if (msg.startsWith('ลบ:')) {
    delete userState[userId];
    return await deleteAppointment(event, userId, msg.replace('ลบ:', ''));
  }
  if (msg.startsWith('แก้ไข:')) {
    delete userState[userId];
    const { data } = await supabase.from('appointments').select('*').eq('id', msg.replace('แก้ไข:', '')).single();
    if (data) {
      userState[userId] = { step: 'editing', apt: data };
      return reply(event, [{ type: 'text', text: `✏️ แก้ไข "${data.title}"\n\nบอกข้อมูลใหม่ได้เลยครับ` }]);
    }
  }

  if (userState[userId]) return handleState(event, userId, msg);

  if (msg === 'สวัสดี' || msg === 'หวัดดี') return reply(event, [flexWelcome()]);
  if (msg === 'เมนู') return reply(event, [flexMenu()]);
  if (msg === 'เพิ่มนัด') return reply(event, [flexAddAppointment()]);
  if (msg === 'ติดต่อเรา') return reply(event, [{ type: 'text', text: '💬 ติดต่อทีมงานได้เลยครับ\n\nLINE: @patinboy\nหรือส่งข้อความมาได้เลยครับ 😊' }]);
  if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') return reply(event, [flexSchedule(await getTodayAppointments(userId))]);
  if (msg === 'นัดหมายทั้งหมด' || msg === 'นัดทั้งหมด') return reply(event, [flexAllSchedule(await getAllAppointments(userId))]);
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

  const parsed = await parseAppointmentWithClaude(msg);
  console.log('Claude parsed:', JSON.stringify(parsed));

  if (!parsed || !parsed.isAppointment) {
    return reply(event, [{
      type: 'text', text: 'พิมพ์ "เมนู" เพื่อดูคำสั่งครับ 😊\n\nหรือบอกนัดหมายได้เลย เช่น\n"พรุ่งนี้ บ่ายโมง ประชุมทีม"',
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
        { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    }]);
  }
  if (!parsed.date) {
    return reply(event, [{ type: 'text', text: `📅 "${parsed.title}" — วันไหนครับ?`,
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: 'วันนี้', text: `${parsed.title} วันนี้ ${parsed.time || ''}`.trim() } },
        { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: `${parsed.title} พรุ่งนี้ ${parsed.time || ''}`.trim() } },
      ]},
    }]);
  }
  if (!parsed.time) return reply(event, [{ type: 'text', text: `⏰ "${parsed.title}" — กี่โมงครับ?\n\nเช่น: 14:00 / บ่ายสอง / 1400` }]);
  return await saveAndReply(event, userId, parsed);
}

async function handleState(event, userId, msg) {
  const state = userState[userId];
  if (state.step === 'editing') {
    const parsed = await parseAppointmentWithClaude(msg);
    if (!parsed || !parsed.isAppointment) {
      delete userState[userId];
      return reply(event, [{ type: 'text', text: '❌ ไม่เข้าใจครับ ยกเลิกการแก้ไขแล้ว' }]);
    }
    const updateData = { reminded: false };
    if (parsed.title) updateData.title = parsed.title;
    if (parsed.date) updateData.meeting_date = parsed.date;
    if (parsed.time) updateData.start_time = `${parsed.time}:00`;
    if (parsed.location) updateData.location = parsed.location;
    const { error } = await supabase.from('appointments').update(updateData).eq('id', state.apt.id);
    delete userState[userId];
    if (error) return reply(event, [{ type: 'text', text: `❌ แก้ไขไม่สำเร็จ: ${error.message}` }]);
    return reply(event, [flexSaveConfirm(parsed.title || state.apt.title, parsed.date || state.apt.meeting_date, parsed.time || state.apt.start_time.slice(0,5), '✏️ แก้ไขนัดหมายแล้ว!')]);
  }
}

async function deleteAppointment(event, userId, id) {
  const { data } = await supabase.from('appointments').select('title').eq('id', id).single();
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  if (error) return reply(event, [{ type: 'text', text: `❌ ลบไม่สำเร็จ: ${error.message}` }]);
  return reply(event, [{ type: 'text', text: `🗑️ ลบ "${data?.title}" แล้วครับ`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ]},
  }]);
}

async function saveAndReply(event, userId, data) {
  const { title, date, time, location } = data;
  const { error } = await supabase.from('appointments').insert({
    user_id: userId, title, meeting_date: date, start_time: `${time}:00`, end_time: null, location: location || null,
  });
  if (error) return reply(event, [{ type: 'text', text: `❌ บันทึกไม่สำเร็จ: ${error.message}` }]);
  return reply(event, [flexSaveConfirm(title, date, time)]);
}

async function getTodayAppointments(userId) {
  const { data, error } = await supabase.from('appointments').select('*')
    .eq('user_id', userId).eq('meeting_date', formatDate(new Date())).order('start_time', { ascending: true });
  if (error) return [];
  return data || [];
}

async function getAllAppointments(userId) {
  const now = new Date();
  const firstDay = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastDay = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const { data, error } = await supabase.from('appointments').select('*')
    .eq('user_id', userId)
    .gte('meeting_date', firstDay)
    .lte('meeting_date', lastDay)
    .order('meeting_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) return [];
  return data || [];
}

function getMinuteDiff(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h1 * 60 + m1) - (h2 * 60 + m2);
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
function flexMenu() {
  return {
    type: 'flex', altText: 'ปฏิทินBoy เมนูหลัก',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'เมนูหลัก', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          navItem('🗓', 'ดูกำหนดการวันนี้', 'นัดหมายทั้งหมดของวันนี้', 'กำหนดการ'),
          navItem('📆', 'นัดหมายทั้งหมด', 'ดูนัดที่กำลังจะมาถึง', 'นัดหมายทั้งหมด'),
          navItem('✏️', 'แก้ไขนัดหมาย', 'แก้ไขนัดหมายวันนี้', 'แก้ไขนัดหมาย'),
          navItem('🗑️', 'ลบนัดหมาย', 'ลบนัดหมายวันนี้', 'ลบนัดหมาย'),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '➕ เพิ่มนัดหมายใหม่', text: 'เพิ่มนัด' } },
        ],
      },
    },
  };
}

function navItem(icon, title, subtitle, action) {
  return {
    type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '10px',
    paddingAll: '12px', spacing: 'md', alignItems: 'center',
    action: { type: 'message', label: title, text: action },
    contents: [
      { type: 'text', text: icon, size: 'lg', flex: 0 },
      { type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: '#111111' },
          { type: 'text', text: subtitle, size: 'xs', color: '#6b7280' },
        ],
      },
      { type: 'text', text: '›', size: 'lg', color: '#d1d5db', flex: 0 },
    ],
  };
}

// ── FLEX: Save Confirm ──
function flexSaveConfirm(title, date, time, headerText = '✅ บันทึกนัดหมายแล้ว!') {
  return {
    type: 'flex', altText: `✅ ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: headerText, size: 'md', weight: 'bold', color: '#06C755' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '14px', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { type: 'text', text: '📋', flex: 0, size: 'sm' },
                  { type: 'text', text: title, weight: 'bold', flex: 1, wrap: true, size: 'sm', color: '#111111' },
                ]},
              { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { type: 'text', text: '📅', flex: 0, size: 'sm' },
                  { type: 'text', text: date, flex: 1, size: 'sm', color: '#6b7280' },
                ]},
              { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { type: 'text', text: '⏰', flex: 0, size: 'sm' },
                  { type: 'text', text: time, flex: 1, size: 'sm', color: '#6b7280' },
                ]},
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '➕ เพิ่มอีก', text: 'เพิ่มนัด' } },
        ],
      },
    },
  };
}

// ── FLEX: Reminder ──
function flexReminder(apt) {
  return {
    type: 'flex', altText: `⏰ ${apt.title} อีก 30 นาที`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '⏰ แจ้งเตือนนัดหมาย', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'อีก 30 นาที!', size: 'xxl', weight: 'bold', color: '#FF6B35' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '14px', spacing: 'sm',
            contents: [
              { type: 'text', text: apt.title, size: 'lg', weight: 'bold', color: '#111111', wrap: true },
              { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
                contents: [{ type: 'text', text: '📅', flex: 0, size: 'sm' }, { type: 'text', text: apt.meeting_date, flex: 1, size: 'sm', color: '#6b7280' }]},
              { type: 'box', layout: 'horizontal', spacing: 'sm',
                contents: [{ type: 'text', text: '⏰', flex: 0, size: 'sm' }, { type: 'text', text: apt.start_time.slice(0,5), flex: 1, size: 'sm', color: '#6b7280' }]},
              apt.location ? { type: 'box', layout: 'horizontal', spacing: 'sm',
                contents: [{ type: 'text', text: '📍', flex: 0, size: 'sm' }, { type: 'text', text: apt.location, flex: 1, size: 'sm', color: '#6b7280', wrap: true }]}
              : { type: 'filler' },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#FF6B35', height: 'sm', action: { type: 'message', label: '📅 ดูกำหนดการ', text: 'กำหนดการ' } },
        ],
      },
    },
  };
}

// ── FLEX: Schedule Today ──
function flexSchedule(appointments) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const now = today.toTimeString().slice(0, 5);

  const items = appointments.length > 0 ? appointments.map(apt => {
    const aptTime = apt.start_time.slice(0, 5);
    const isPast = aptTime < now;
    const diff = getMinuteDiff(aptTime, now);
    const isUpcoming = !isPast && diff <= 60;

    const bg = isPast ? '#f5f5f5' : isUpcoming ? '#fff7ed' : '#f9fafb';
    const timeColor = isPast ? '#cccccc' : isUpcoming ? '#ea580c' : '#06C755';
    const titleColor = isPast ? '#999999' : '#111111';

    return {
      type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
      contents: [
        { type: 'box', layout: 'horizontal', alignItems: 'center',
          contents: [
            { type: 'box', layout: 'vertical', flex: 1,
              contents: [
                { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
                  contents: [
                    { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: titleColor, flex: 1, wrap: true },
                    isUpcoming ? { type: 'text', text: `อีก ${diff} นาที`, size: 'xs', color: '#ffffff', backgroundColor: '#FF6B35', cornerRadius: '20px', paddingAll: '3px', flex: 0 } : { type: 'filler' },
                  ],
                },
                apt.location ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#6b7280', margin: 'xs' } : { type: 'filler' },
              ],
            },
          ],
        },
        { type: 'text', text: aptTime, size: 'xs', color: timeColor, weight: 'bold', margin: 'xs' },
      ],
    };
  }) : [{
    type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '16px',
    contents: [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊', size: 'sm', color: '#6b7280', align: 'center' }],
  }];

  return {
    type: 'flex', altText: `กำหนดการวันนี้ — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: dateStr, size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'กำหนดการวันนี้', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#06C755', cornerRadius: '20px', paddingAll: '4px', paddingStart: '10px', paddingEnd: '10px',
                contents: [{ type: 'text', text: `${appointments.length} รายการ`, size: 'xs', color: '#ffffff', weight: 'bold' }] },
            ],
          },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: All Schedule (จัดกลุ่มตามวัน) ──
function flexAllSchedule(appointments) {
  const now = new Date();
  const monthStr = now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  const dayNames = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const colors = ['#06C755', '#3b82f6', '#FF6B35', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b'];

  if (appointments.length === 0) {
    return {
      type: 'flex', altText: 'นัดหมายเดือนนี้',
      contents: {
        type: 'bubble',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
          contents: [
            { type: 'text', text: monthStr, size: 'xs', color: '#94a3b8' },
            { type: 'text', text: 'นัดหมายเดือนนี้', size: 'xl', weight: 'bold', color: '#ffffff' },
          ],
        },
        body: {
          type: 'box', layout: 'vertical', paddingAll: '16px',
          contents: [{
            type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '16px',
            contents: [{ type: 'text', text: 'ไม่มีนัดหมายเดือนนี้ครับ 😊', size: 'sm', color: '#6b7280', align: 'center' }],
          }],
        },
        footer: {
          type: 'box', layout: 'vertical', paddingAll: '12px',
          contents: [{ type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } }],
        },
      },
    };
  }

  // จัดกลุ่มตามวัน
  const groups = {};
  for (const apt of appointments) {
    const d = apt.meeting_date;
    if (!groups[d]) groups[d] = [];
    groups[d].push(apt);
  }

  let colorIdx = 0;
  const items = [];
  for (const [date, apts] of Object.entries(groups)) {
    const d = new Date(date + 'T00:00:00');
    const dayName = dayNames[d.getDay()];
    const day = d.getDate();
    const month = monthNames[d.getMonth()];
    const color = colors[colorIdx % colors.length];
    colorIdx++;

    // Group header
    items.push({
      type: 'text', text: `${dayName}ที่ ${day} ${month}`,
      size: 'xs', weight: 'bold', color: color,
      margin: items.length > 0 ? 'md' : 'none',
    });

    // Appointments in this group
    for (const apt of apts) {
      const isOrange = apt.start_time.slice(0,5) < new Date().toTimeString().slice(0,5) && date === new Date().toISOString().slice(0,10);
      items.push({
        type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px',
        paddingAll: '10px', margin: 'xs', spacing: 'sm', alignItems: 'center',
        contents: [
          { type: 'box', layout: 'vertical', flex: 0, width: '4px', height: '32px', backgroundColor: color, cornerRadius: '2px' },
          { type: 'box', layout: 'vertical', flex: 1, paddingStart: '8px',
            contents: [
              { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
              apt.location
                ? { type: 'text', text: `⏰ ${apt.start_time.slice(0,5)}  📍 ${apt.location}`, size: 'xs', color: '#6b7280', margin: 'xs' }
                : { type: 'text', text: `⏰ ${apt.start_time.slice(0,5)}`, size: 'xs', color: '#6b7280', margin: 'xs' },
            ],
          },
        ],
      });
    }
  }

  return {
    type: 'flex', altText: `นัดหมายเดือนนี้ — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: monthStr, size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'นัดหมายเดือนนี้', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'box', layout: 'vertical', backgroundColor: '#06C755', cornerRadius: '20px', paddingAll: '4px', paddingStart: '10px', paddingEnd: '10px', margin: 'sm',
            contents: [{ type: 'text', text: `${appointments.length} รายการ`, size: 'xs', color: '#ffffff', weight: 'bold' }] },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1, action: { type: 'message', label: '+ เพิ่มนัด', text: 'เพิ่มนัด' } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
        ],
      },
    },
  };
}

// ── FLEX: Select Appointment ──
function flexSelectAppointment(apts, action) {
  const isDelete = action === 'ลบ';
  const items = apts.map(apt => ({
    type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '10px',
    paddingAll: '12px', margin: 'sm', alignItems: 'center',
    action: { type: 'message', label: apt.title, text: `${action}:${apt.id}` },
    contents: [
      { type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
          { type: 'text', text: apt.start_time.slice(0,5), size: 'xs', color: '#6b7280' },
        ],
      },
      { type: 'text', text: isDelete ? '🗑️' : '✏️', size: 'lg', flex: 0 },
    ],
  }));

  return {
    type: 'flex', altText: `เลือกนัดที่จะ${action}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [{ type: 'text', text: `เลือกนัดที่จะ${action}ครับ`, size: 'md', weight: 'bold', color: isDelete ? '#FF6B35' : '#06C755' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
    },
  };
}


// ── FLEX: Add Appointment ──
function flexAddAppointment() {
  return {
    type: 'flex', altText: 'เพิ่มนัดหมายใหม่',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
        contents: [
          { type: 'text', text: '➕ เพิ่มนัดหมายใหม่', size: 'xs', color: '#ffffff' },
          { type: 'text', text: 'บอกได้เลยครับ!', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'text', text: 'พิมพ์นัดหมายแบบธรรมชาติได้เลยครับ', size: 'sm', color: '#111111', weight: 'bold' },
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm', spacing: 'sm',
            contents: [
              { type: 'text', text: '"พรุ่งนี้ บ่ายโมง ประชุมทีม"', size: 'sm', color: '#6b7280' },
              { type: 'text', text: '"15/3 14:00 นัดหมอ"', size: 'sm', color: '#6b7280' },
              { type: 'text', text: '"วันนี้ 3 ทุ่ม กินข้าวกับครอบครัว"', size: 'sm', color: '#6b7280' },
            ],
          },
          { type: 'text', text: 'AI จะวิเคราะห์และบันทึกให้อัตโนมัติครับ', size: 'xs', color: '#9ca3af', margin: 'sm' },
        ],
      },
    },
  };
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));