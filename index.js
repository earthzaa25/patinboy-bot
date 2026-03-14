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
  const target = new Date(now.getTime() + 30 * 60 * 1000);
  const th = String(target.getHours()).padStart(2, '0');
  const tm = String(target.getMinutes()).padStart(2, '0');
  const targetTime = `${th}:${tm}:00`;

  const { data, error } = await supabase
    .from('appointments').select('*')
    .eq('meeting_date', todayStr).eq('start_time', targetTime).eq('reminded', false);

  if (error || !data || data.length === 0) return;

  for (const apt of data) {
    try {
      await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt)] });
      await supabase.from('appointments').update({ reminded: true }).eq('id', apt.id);
      console.log(`✅ แจ้งเตือน: ${apt.title}`);
    } catch (err) { console.error('Push error:', err.message); }
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const content = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(content);
  } catch (err) { console.error('Claude API error:', err); return null; }
}

const userState = {};

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  if (msg.startsWith('ลบ:')) {
    delete userState[userId];
    return await deleteAppointment(event, userId, msg.replace('ลบ:', ''));
  }
  if (msg.startsWith('แก้ไข:')) {
    delete userState[userId];
    const id = msg.replace('แก้ไข:', '');
    const { data } = await supabase.from('appointments').select('*').eq('id', id).single();
    if (data) {
      userState[userId] = { step: 'editing', apt: data };
      return reply(event, [{ type: 'text', text: `✏️ แก้ไข "${data.title}"\n\nบอกข้อมูลใหม่ได้เลยครับ เช่น\n"พรุ่งนี้ บ่ายสอง ประชุมทีม"` }]);
    }
  }

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

async function deleteAppointment(event, userId, id) {
  const { data } = await supabase.from('appointments').select('title').eq('id', id).single();
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  if (error) return reply(event, [{ type: 'text', text: `❌ ลบไม่สำเร็จ: ${error.message}` }]);
  return reply(event, [{
    type: 'text', text: `🗑️ ลบ "${data?.title || 'นัดหมาย'}" แล้วครับ`,
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
  if (error) return reply(event, [{ type: 'text', text: `❌ บันทึกไม่สำเร็จครับ\nError: ${error.message}` }]);
  return reply(event, [flexSaveConfirm(title, date, time)]);
}

async function getTodayAppointments(userId) {
  const today = formatDate(new Date());
  const { data, error } = await supabase.from('appointments').select('*')
    .eq('user_id', userId).eq('meeting_date', today).order('start_time', { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function getAllAppointments(userId) {
  const today = formatDate(new Date());
  const { data, error } = await supabase.from('appointments').select('*')
    .eq('user_id', userId).gte('meeting_date', today)
    .order('meeting_date', { ascending: true }).order('start_time', { ascending: true }).limit(20);
  if (error) { console.error(error); return []; }
  return data || [];
}

function getMinuteDiff(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h1 * 60 + m1) - (h2 * 60 + m2);
}

// ── FLEX: Welcome (Style 3) ──
function flexWelcome() {
  return {
    type: 'flex', altText: 'สวัสดีครับ! ผม ปฏิทินBoy',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '20px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#ffffff', weight: 'bold' },
          { type: 'text', text: 'สวัสดีครับ!', size: 'xxl', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: 'ใช้ได้ฟรีตลอด ไม่มีค่าใช้จ่าย', size: 'sm', color: '#ffffff', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'vertical', backgroundColor: '#EAF3DE', cornerRadius: '10px', paddingAll: '12px',
            contents: [
              { type: 'text', text: 'บอกนัดหมายได้เลยครับ', size: 'sm', weight: 'bold', color: '#27500A' },
              { type: 'text', text: '"พรุ่งนี้ บ่ายโมง ประชุมทีม"', size: 'xs', color: '#3B6D11', margin: 'xs' },
            ],
          },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#FAECE7', cornerRadius: '10px', paddingAll: '12px',
            contents: [
              { type: 'text', text: 'แจ้งเตือนอัตโนมัติ', size: 'sm', weight: 'bold', color: '#4A1B0C' },
              { type: 'text', text: 'ก่อนถึงนัด 30 นาที', size: 'xs', color: '#993C1D', margin: 'xs' },
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

// ── FLEX: Menu (Style 3) ──
function flexMenu() {
  return {
    type: 'flex', altText: 'ปฏิทินBoy เมนูหลัก',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📅 ปฏิทินBoy', size: 'xs', color: '#ffffff' },
          { type: 'text', text: 'เมนูหลัก', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          menuCard('🗓', 'ดูกำหนดการวันนี้', '#EAF3DE', '#27500A', '#3B6D11', 'กำหนดการ'),
          menuCard('📆', 'นัดหมายทั้งหมด', '#E6F1FB', '#0C447C', '#185FA5', 'นัดหมายทั้งหมด'),
          menuCard('✏️', 'แก้ไขนัดหมาย', '#FAEEDA', '#633806', '#854F0B', 'แก้ไขนัดหมาย'),
          menuCard('🗑️', 'ลบนัดหมาย', '#FAECE7', '#4A1B0C', '#993C1D', 'ลบนัดหมาย'),
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

function menuCard(icon, label, bg, titleColor, subtitleColor, action) {
  return {
    type: 'box', layout: 'horizontal', backgroundColor: bg, cornerRadius: '10px',
    paddingAll: '12px', spacing: 'md', alignItems: 'center',
    action: { type: 'message', label, text: action },
    contents: [
      { type: 'text', text: icon, size: 'xl', flex: 0 },
      { type: 'text', text: label, size: 'sm', weight: 'bold', color: titleColor, flex: 1 },
      { type: 'text', text: '›', size: 'lg', color: subtitleColor, flex: 0 },
    ],
  };
}

// ── FLEX: Save Confirm (Style 3) ──
function flexSaveConfirm(title, date, time, headerText = '✅ บันทึกนัดหมายแล้ว!') {
  return {
    type: 'flex', altText: `✅ บันทึกนัด: ${title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
        contents: [
          { type: 'text', text: headerText, size: 'md', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          {
            type: 'box', layout: 'vertical', backgroundColor: '#EAF3DE', cornerRadius: '10px', paddingAll: '14px', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '📋', flex: 0, size: 'sm' },
                { type: 'text', text: title, weight: 'bold', flex: 1, wrap: true, size: 'sm', color: '#27500A', margin: 'sm' },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '📅', flex: 0, size: 'sm' },
                { type: 'text', text: date, flex: 1, size: 'sm', color: '#3B6D11', margin: 'sm' },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '⏰', flex: 0, size: 'sm' },
                { type: 'text', text: time, flex: 1, size: 'sm', color: '#3B6D11', margin: 'sm' },
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

// ── FLEX: Reminder (Style 3) ──
function flexReminder(apt) {
  return {
    type: 'flex', altText: `⏰ แจ้งเตือน: ${apt.title} อีก 30 นาที`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#FF6B35', paddingAll: '16px',
        contents: [
          { type: 'text', text: '⏰ แจ้งเตือนนัดหมาย', size: 'xs', color: '#ffffff' },
          { type: 'text', text: 'อีก 30 นาที!', size: 'xxl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'vertical', backgroundColor: '#FAECE7', cornerRadius: '10px', paddingAll: '14px', spacing: 'sm',
            contents: [
              { type: 'text', text: apt.title, size: 'lg', weight: 'bold', color: '#4A1B0C', wrap: true },
              { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
                { type: 'text', text: '📅', flex: 0, size: 'sm' },
                { type: 'text', text: apt.meeting_date, flex: 1, size: 'sm', color: '#993C1D', margin: 'sm' },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '⏰', flex: 0, size: 'sm' },
                { type: 'text', text: apt.start_time.slice(0,5), flex: 1, size: 'sm', color: '#993C1D', margin: 'sm' },
              ]},
              apt.location ? { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '📍', flex: 0, size: 'sm' },
                { type: 'text', text: apt.location, flex: 1, size: 'sm', color: '#993C1D', margin: 'sm', wrap: true },
              ]} : { type: 'filler' },
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

// ── FLEX: Schedule Today (Style 3) ──
function flexSchedule(appointments) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const now = today.toTimeString().slice(0, 5);

  const items = appointments.length > 0 ? appointments.map(apt => {
    const aptTime = apt.start_time.slice(0, 5);
    const isPast = aptTime < now;
    const diff = getMinuteDiff(aptTime, now);
    const isUpcoming = !isPast && diff <= 60;

    const bg = isPast ? '#f5f5f5' : isUpcoming ? '#FAECE7' : '#EAF3DE';
    const borderColor = isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#06C755';
    const titleColor = isPast ? '#999999' : isUpcoming ? '#4A1B0C' : '#27500A';
    const timeColor = isPast ? '#cccccc' : isUpcoming ? '#FF6B35' : '#3B6D11';

    return {
      type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '10px',
      paddingAll: '12px', margin: 'sm',
      contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'box', layout: 'vertical', flex: 0, width: '4px', height: '40px', backgroundColor: borderColor, cornerRadius: '2px' },
            {
              type: 'box', layout: 'vertical', flex: 1, paddingStart: '10px',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: titleColor, flex: 1, wrap: true },
                  isUpcoming ? { type: 'text', text: `อีก ${diff} นาที`, size: 'xs', color: '#ffffff', backgroundColor: '#FF6B35', cornerRadius: '20px', paddingAll: '3px', flex: 0 } : { type: 'filler' },
                ]},
                { type: 'text', text: aptTime, size: 'xs', color: timeColor, margin: 'xs' },
                apt.location ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: timeColor } : { type: 'filler' },
              ],
            },
          ],
        },
      ],
    };
  }) : [{
    type: 'box', layout: 'vertical', backgroundColor: '#EAF3DE', cornerRadius: '10px', paddingAll: '16px',
    contents: [{ type: 'text', text: 'ไม่มีนัดหมายวันนี้ครับ 😊', size: 'sm', color: '#3B6D11', align: 'center' }],
  }];

  return {
    type: 'flex', altText: `กำหนดการวันนี้ — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
        contents: [
          { type: 'text', text: dateStr, size: 'xs', color: '#ffffff' },
          { type: 'text', text: 'กำหนดการวันนี้', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: `${appointments.length} รายการ`, size: 'xs', color: '#ffffff', margin: 'xs' },
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

// ── FLEX: All Schedule (Style 3) ──
function flexAllSchedule(appointments) {
  const items = appointments.length > 0 ? appointments.map(apt => ({
    type: 'box', layout: 'horizontal', backgroundColor: '#EAF3DE', cornerRadius: '10px',
    paddingAll: '12px', margin: 'sm', spacing: 'md', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', flex: 0, width: '44px', alignItems: 'center',
        contents: [
          { type: 'text', text: apt.meeting_date.slice(5), size: 'xs', weight: 'bold', color: '#27500A', align: 'center' },
          { type: 'text', text: apt.start_time.slice(0,5), size: 'xs', color: '#3B6D11', align: 'center' },
        ],
      },
      { type: 'separator' },
      {
        type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#27500A', wrap: true },
          apt.location ? { type: 'text', text: `📍 ${apt.location}`, size: 'xs', color: '#3B6D11' } : { type: 'filler' },
        ],
      },
    ],
  })) : [{
    type: 'box', layout: 'vertical', backgroundColor: '#EAF3DE', cornerRadius: '10px', paddingAll: '16px',
    contents: [{ type: 'text', text: 'ไม่มีนัดหมายที่กำลังจะมาถึงครับ 😊', size: 'sm', color: '#3B6D11', align: 'center' }],
  }];

  return {
    type: 'flex', altText: `นัดหมายทั้งหมด — ${appointments.length} รายการ`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
        contents: [
          { type: 'text', text: 'นัดหมายที่กำลังจะมาถึง', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: `${appointments.length} รายการ`, size: 'xs', color: '#ffffff', margin: 'xs' },
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
  const bg = action === 'ลบ' ? '#FAECE7' : '#FAEEDA';
  const titleColor = action === 'ลบ' ? '#4A1B0C' : '#633806';
  const timeColor = action === 'ลบ' ? '#993C1D' : '#854F0B';
  const headerBg = action === 'ลบ' ? '#FF6B35' : '#EF9F27';

  const items = apts.map(apt => ({
    type: 'box', layout: 'horizontal', backgroundColor: bg, cornerRadius: '10px',
    paddingAll: '12px', margin: 'sm', alignItems: 'center',
    action: { type: 'message', label: apt.title, text: `${action}:${apt.id}` },
    contents: [
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: titleColor, wrap: true },
        { type: 'text', text: apt.start_time.slice(0,5), size: 'xs', color: timeColor },
      ]},
      { type: 'text', text: action === 'ลบ' ? '🗑️' : '✏️', size: 'lg', flex: 0 },
    ],
  }));

  return {
    type: 'flex', altText: `เลือกนัดที่จะ${action}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: headerBg, paddingAll: '16px',
        contents: [{ type: 'text', text: `เลือกนัดที่จะ${action}ครับ`, size: 'md', weight: 'bold', color: '#ffffff' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
    },
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));