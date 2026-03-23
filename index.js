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

// endpoint รับรูปภาพจาก LINE
async function getImageBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

function reply(event, messages) {
  return client.replyMessage({ replyToken: event.replyToken, messages });
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── แจ้งเตือนอัตโนมัติทุก 1 นาที (ใช้ setInterval แทน node-cron) ──
async function checkReminders() {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const todayStr = formatDate(now);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    console.log(`🔔 เช็คแจ้งเตือน (ไทย): ${todayStr} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);

    // ดึงนัดวันนี้ที่ยังไม่ reminded (Free plan - 30 นาที fixed)
    const target30 = new Date(now.getTime() + 30 * 60 * 1000);
    const targetTime = `${String(target30.getHours()).padStart(2,'0')}:${String(target30.getMinutes()).padStart(2,'0')}:00`;
    const { data: freeApts } = await supabase.from('appointments').select('*')
      .eq('meeting_date', todayStr).eq('start_time', targetTime).eq('reminded', false);

    for (const apt of (freeApts || [])) {
      const plan = await getUserPlan(apt.user_id);
      // Free plan หรือไม่มี custom reminders → ใช้ 30 นาที default
      if (!apt.reminders || apt.reminders.length === 0) {
        try {
          await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt, 30)] });
          await supabase.from('appointments').update({ reminded: true }).eq('id', apt.id);
          console.log(`✅ แจ้งเตือน (30 นาที): ${apt.title}`);
        } catch (err) { console.error('Push error:', err.message); }
      }
    }

    // ดึงนัดที่มี custom reminders (Personal/Business)
    const { data: customApts } = await supabase.from('appointments').select('*')
      .eq('meeting_date', todayStr)
      .not('reminders', 'eq', '[]')
      .not('reminders', 'is', null);

    for (const apt of (customApts || [])) {
      const reminders = apt.reminders || [];
      const [h, m] = apt.start_time.slice(0,5).split(':').map(Number);
      const aptMins = h * 60 + m;

      for (let i = 0; i < reminders.length; i++) {
        const r = reminders[i];
        if (r.sent) continue;
        const triggerMins = aptMins - r.minutes;
        if (currentMins === triggerMins) {
          try {
            await client.pushMessage({ to: apt.user_id, messages: [flexReminder(apt, r.minutes)] });
            reminders[i].sent = true;
            await supabase.from('appointments').update({ reminders }).eq('id', apt.id);
            console.log(`✅ แจ้งเตือน (${r.minutes} นาที): ${apt.title}`);
          } catch (err) { console.error('Push error:', err.message); }
        }
      }
    }
    // ── Auto-delete นัดที่ผ่านไปแล้ว (วันเก่า + วันนี้ที่เกิน 1 ชั่วโมง) ──
    // ลบนัดวันที่ผ่านมาแล้วทั้งหมด
    const { data: pastApts } = await supabase.from('appointments').select('id, title, meeting_date, start_time')
      .lt('meeting_date', todayStr);
    for (const apt of (pastApts || [])) {
      await supabase.from('appointments').delete().eq('id', apt.id);
      console.log(`🗑️ Auto-delete (past): ${apt.title} (${apt.meeting_date})`);
    }
    // ลบนัดวันนี้ที่เกิน 1 ชั่วโมงไปแล้ว
    const { data: oldApts } = await supabase.from('appointments').select('id, title, meeting_date, start_time')
      .eq('meeting_date', todayStr);
    for (const apt of (oldApts || [])) {
      const [h, m] = apt.start_time.slice(0,5).split(':').map(Number);
      const aptMins = h * 60 + m;
      const nowMins = now.getHours() * 60 + now.getMinutes();
      if (nowMins >= aptMins + 60) {
        await supabase.from('appointments').delete().eq('id', apt.id);
        console.log(`🗑️ Auto-delete (today): ${apt.title} (${apt.start_time.slice(0,5)})`);
      }
    }
  } catch (err) { console.error('checkReminders error:', err); }
}
setInterval(checkReminders, 60 * 1000);

async function parseAppointmentWithClaude(text) {
  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const systemPrompt = `คุณเป็น AI ผู้ช่วยวิเคราะห์ข้อความนัดหมายภาษาไทย
วันนี้คือ ${todayStr} พรุ่งนี้คือ ${tomorrowStr}

กฎการแปลงเวลา:
- 0700, 700 = 07:00 (7 โมงเช้า)
- 0800, 800 = 08:00 (8 โมงเช้า)
- 0900, 900 = 09:00 (9 โมงเช้า)
- 1000 = 10:00, 1100 = 11:00, 1200 = 12:00
- 1300 = 13:00, 1400 = 14:00, 1500 = 15:00
- 1600 = 16:00, 1700 = 17:00, 1800 = 18:00
- 1900 = 19:00, 2000 = 20:00, 2100 = 21:00
- 2200 = 22:00, 2300 = 23:00
- ถ้าเห็น HH:MM ให้เก็บตรงๆ ห้ามปัดเวลา เช่น 14:35 = 14:35
- เที่ยง, 12:00 = 12:00
- เที่ยงคืน, ตี12 = 00:00
- บ่ายโมง, บ่าย1 = 13:00
- บ่ายโมงครึ่ง = 13:30
- บ่ายสอง, บ่าย2 = 14:00
- บ่ายสองครึ่ง = 14:30
- บ่ายสาม, บ่าย3 = 15:00
- บ่ายสี่, บ่าย4 = 16:00
- บ่ายห้า, บ่าย5 = 17:00
- หกโมงเย็น, 6โมงเย็น = 18:00
- ทุ่มหนึ่ง, หนึ่งทุ่ม, 1ทุ่ม = 19:00
- สองทุ่ม, 2ทุ่ม = 20:00
- สามทุ่ม, 3ทุ่ม = 21:00
- สี่ทุ่ม, 4ทุ่ม = 22:00
- ห้าทุ่ม, 5ทุ่ม = 23:00
- ตีหนึ่ง, ตี1 = 01:00
- ตีสอง, ตี2 = 02:00
- ตีสาม, ตี3 = 03:00
- 3pm, 3PM = 15:00
- 9am, 9AM = 09:00
- 10am = 10:00, 2pm = 14:00

กฎการแปลงวัน:
- วันนี้ = ${todayStr}
- พรุ่งนี้ = ${tomorrowStr}
- มะรืน = วันหลังพรุ่งนี้
- อาทิตย์หน้า, สัปดาห์หน้า = 7 วันข้างหน้า
- วันจันทร์ถัดไป, จันทร์หน้า = จันทร์ถัดไป
- ต้นเดือนหน้า = วันที่ 1 เดือนหน้า
- DD/MM หรือ DD/MM/YYYY = แปลงเป็น YYYY-MM-DD

คำย่อที่รู้จัก:
- ปท, ประชุม, meeting, mtg = ชื่อนัด
- นพ, หมอ, doctor = นัดหมอ
- รพ = โรงพยาบาล
- ออฟฟิศ, office = ที่ทำงาน

ตอบเฉพาะ JSON เท่านั้น ไม่มีคำอธิบาย:
{"isAppointment":true/false,"title":"ชื่อนัดหมาย","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null","notes":"รายละเอียดเพิ่มเติม หรือ null"}

ตัวอย่าง: "ออกกำลังกาย 6 โมงเย็น ขาช่วงล่าง" → title="ออกกำลังกาย", time="18:00", notes="ขาช่วงล่าง"
ถ้าไม่เกี่ยวกับนัดหมายเลย ให้ isAppointment=false`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: `ข้อความ: "${text}"` }],
      }),
    });
    const data = await res.json();
    if (!data.content || !data.content[0]) {
      console.error('Claude error:', JSON.stringify(data).slice(0, 200));
      return null;
    }
    const content = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const match = content.match(/{[\s\S]*}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) { console.error('Claude API error:', err); return null; }
}

const userState = {};

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const userId = event.source.userId;

  // รองรับรูปภาพ (Personal+)
  if (event.message.type === 'image') {
    const plan = await getUserPlan(userId);
    if (!canUsePremium(plan)) {
      return reply(event, [flexText('🔒 การส่งรูปเพื่อนัดหมายสำหรับ Personal Plan ขึ้นไปครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียดการอัปเกรด')]);
    }
    try {
      const imageBase64 = await getImageBase64(event.message.id);
      return await handleImageAppointment(event, userId, imageBase64);
    } catch(err) {
      console.error('Image error:', err);
      return reply(event, [flexText('❌ ไม่สามารถอ่านรูปได้ครับ ลองส่งใหม่อีกครั้ง')]);
    }
  }

  if (event.message.type !== 'text') return;
  const msg = event.message.text.trim();
  console.log('USER ID:', userId);

  // เช็ค userState สำหรับ reminder flow ก่อน
  if (userState[userId] && (userState[userId].step === 'selectReminder' || userState[userId].step === 'pickReminderTime')) {
    return handleState(event, userId, msg);
  }

  if (msg.startsWith('ลบ:')) {
    delete userState[userId];
    return await deleteAppointment(event, userId, msg.replace('ลบ:', ''));
  }
  if (/^แจ้งเตือน\d+$/.test(msg)) {
    const mins = parseInt(msg.replace('แจ้งเตือน', ''));
    const state = userState[userId];
    if (state && state.aptId && (state.step === 'selectReminder' || state.step === 'pickReminderTime')) {
      const aptId = state.aptId;
      delete userState[userId];
      return await handleSetReminder(event, userId, aptId, mins);
    }
    return reply(event, [{ type: 'text', text: '❌ กรุณาเลือกนัดหมายก่อนครับ พิมพ์ "ตั้งแจ้งเตือน" ใหม่อีกครั้ง' }]);
  }
  if (msg.startsWith('แก้ไข:')) {
    delete userState[userId];
    const { data } = await supabase.from('appointments').select('*').eq('id', msg.replace('แก้ไข:', '')).single();
    if (data) {
      userState[userId] = { step: 'editing', apt: data };
      return reply(event, [flexText(`✏️ แก้ไข "${data.title}"\n\nบอกข้อมูลใหม่ได้เลยครับ`)]);
    }
  }

  if (userState[userId]) return handleState(event, userId, msg);

  if (msg === 'สวัสดี' || msg === 'หวัดดี') return reply(event, [flexWelcome()]);
  if (msg === 'แพลน' || msg === 'plan') {
    const user = await getOrCreateUser(userId);
    return reply(event, [flexPlan(user?.plan || 'free', user?.plan_expires_at)]);
  }
  if (msg === 'อัปเกรด Personal' || msg === 'อัปเกรด Business') {
    const planName = msg.includes('Personal') ? 'Personal ฿30/เดือน' : 'Business ฿199/เดือน';
    return reply(event, [{ type: 'text', text: `💳 อัปเกรด ${planName}\n\nโอนเงินมาที่:\nธนาคาร: กสิกรไทย\nเลขบัญชี: xxx-x-xxxxx-x\nชื่อ: ปฏิทินBoy\n\nแล้วส่งสลิปมาที่นี่เลยครับ ทีมงานจะอัปเกรดให้ภายใน 30 นาทีครับ 😊` }]);
  }
  if (msg === 'เมนู') return reply(event, [await flexMenu(userId)]);
  if (msg === 'เพิ่มนัด') return reply(event, [flexAddAppointment()]);
  if (msg === 'ติดต่อเรา') return reply(event, [flexContact()]);
  if (msg === 'ทีม' || msg === 'จัดการทีม') return await handleTeam(event, userId);
  if (msg.startsWith('เข้าร่วม ') || msg.startsWith('เข้าร่วม')) {
    const code = msg.replace('เข้าร่วม', '').trim();
    if (code) return await joinTeamByCode(event, userId, code);
  }
  if (msg === 'สร้างทีม') {
    const plan = await getUserPlan(userId);
    if (!canUseBusiness(plan)) return reply(event, [{ type: 'text', text: '🔒 สำหรับ Business Plan เท่านั้นครับ' }]);
    userState[userId] = { step: 'creatingTeam' };
    return reply(event, [flexText('👥 ตั้งชื่อทีมได้เลยครับ\n\nเช่น: ทีมขาย, ทีม HR, ออฟฟิศ A')]);
  }
  if (msg.startsWith('link:')) {
    const teamName = msg.replace('link:', '');
    const { data: team } = await supabase.from('teams').select('id, name').eq('name', teamName).eq('owner_line_id', userId).single();
    if (!team) return reply(event, [flexText('❌ ไม่พบทีมครับ')]);
    const code = await createInviteLink(team.id, userId);
    return reply(event, [{ type: 'text', text: `🔗 Link เชิญเข้าทีม "${team.name}"\n\nส่งข้อความนี้ให้สมาชิกพิมพ์ใน ปฏิทินBoy:\n\n👉 เข้าร่วม ${code}\n\n⏰ หมดอายุใน 7 วันครับ` }]);
  }
  if (msg.startsWith('สมาชิก:')) {
    const teamName = msg.replace('สมาชิก:', '');
    const { data: team } = await supabase.from('teams').select('id').eq('name', teamName).eq('owner_line_id', userId).single();
    if (!team) return reply(event, [flexText('❌ ไม่พบทีมครับ')]);
    const { data: members } = await supabase.from('team_members').select('*').eq('team_id', team.id);
    const count = members?.length || 0;
    const list = count > 0 ? members.map((m, i) => `${i+1}. สมาชิก (${m.role})`).join('\n') : 'ยังไม่มีสมาชิกครับ';
    return reply(event, [{ type: 'text', text: `👥 สมาชิกทีม "${teamName}"\n\n${list}\n\nรวม ${count} คนครับ` }]);
  }
  if (msg === 'แจ้งปัญหาการใช้งาน' || msg === 'แนะนำฟีเจอร์' || msg === 'สอบถามแผนและราคา' || msg === 'อื่นๆ') {
    return reply(event, [{ type: 'text', text: `✅ รับเรื่องแล้วครับ!

หัวข้อ: ${msg}

ทีมงานจะติดต่อกลับภายใน 24 ชั่วโมงครับ 😊`, quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ]}}]);
  }
  if (msg === 'กำหนดการ' || msg === 'ดูนัดหมาย') return reply(event, [flexSchedule(await getTodayAppointments(userId))]);
  if (msg === 'นัดหมายทั้งหมด' || msg === 'นัดทั้งหมด') return reply(event, [flexAllSchedule(await getAllAppointments(userId))]);
  if (msg === 'ตั้งแจ้งเตือน') {
    const plan = await getUserPlan(userId);
    if (!canUsePremium(plan)) return reply(event, [flexText('🔒 ฟีเจอร์นี้สำหรับ Personal Plan ขึ้นไปครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียด')]);
    const apts = await getAllAppointments(userId);
    if (apts.length === 0) return reply(event, [flexText('ไม่มีนัดหมายครับ 😊')]);
    userState[userId] = { step: 'selectReminder', apts };
    return reply(event, [flexSelectReminderApt(apts)]);
  }
  if (msg === 'จัดการนัด') {
    return reply(event, [flexManageMenu()]);
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
  if (!parsed.time) return reply(event, [flexText(`⏰ "${parsed.title}" — กี่โมงครับ?\n\nเช่น: 14:00 / บ่ายสอง / 1400`)]);
  return await saveAndReply(event, userId, parsed);
}

async function handleState(event, userId, msg) {
  const state = userState[userId];

  if (state.step === 'selectReminder') {
    // ผู้ใช้พิมพ์ชื่อนัด → หา aptId จาก apts
    const apt = state.apts?.find(a => a.title === msg || msg.includes(a.title));
    if (apt) {
      const plan = await getUserPlan(userId);
      userState[userId] = { step: 'pickReminderTime', aptId: apt.id };
      return reply(event, [flexSetReminder(apt.id, canUseBusiness(plan))]);
    }
    delete userState[userId];
    return reply(event, [flexText('❌ ไม่พบนัดหมายครับ ลองใหม่อีกครั้ง')]);
  }

  if (state.step === 'pickReminderTime' && /^แจ้งเตือน\d+$/.test(msg)) {
    const mins = parseInt(msg.replace('แจ้งเตือน', ''));
    delete userState[userId];
    return await handleSetReminder(event, userId, state.aptId, mins);
  }

  if (state.step === 'creatingTeam') {
    const teamName = msg.trim();
    if (!teamName) return reply(event, [flexText('❌ กรุณาพิมพ์ชื่อทีมครับ')]);
    const { error } = await supabase.from('teams').insert({ name: teamName, owner_line_id: userId });
    delete userState[userId];
    if (error) return reply(event, [flexText('❌ สร้างทีมไม่สำเร็จครับ')]);
    return reply(event, [flexText(`✅ สร้างทีม "${teamName}" สำเร็จแล้วครับ!\n\nพิมพ์ "จัดการทีม" เพื่อเชิญสมาชิก`, [
      { type: 'action', action: { type: 'message', label: '👥 จัดการทีม', text: 'จัดการทีม' } },
    ])]);
  }

  if (state.step === 'editing') {
    const parsed = await parseAppointmentWithClaude(msg);
    if (!parsed || !parsed.isAppointment) {
      delete userState[userId];
      return reply(event, [flexText('❌ ไม่เข้าใจครับ ยกเลิกการแก้ไขแล้ว')]);
    }
    const updateData = { reminded: false };
    if (parsed.title) updateData.title = parsed.title;
    if (parsed.date) updateData.meeting_date = parsed.date;
    if (parsed.time) updateData.start_time = `${parsed.time}:00`;
    if (parsed.location) updateData.location = parsed.location;
    const { error } = await supabase.from('appointments').update(updateData).eq('id', state.apt.id);
    delete userState[userId];
    if (error) return reply(event, [flexText(`❌ แก้ไขไม่สำเร็จ: ${error.message}`)]);
    return reply(event, [flexSaveConfirm(parsed.title || state.apt.title, parsed.date || state.apt.meeting_date, parsed.time || state.apt.start_time.slice(0,5), '✏️ แก้ไขนัดหมายแล้ว!')]);
  }
}

async function deleteAppointment(event, userId, id) {
  const { data } = await supabase.from('appointments').select('title').eq('id', id).single();
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  if (error) return reply(event, [flexText(`❌ ลบไม่สำเร็จ: ${error.message}`)]);
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
    user_id: userId, title, meeting_date: date, start_time: `${time}:00`, end_time: null, location: location || null, notes: data.notes || null,
  });
  if (error) return reply(event, [flexText(`❌ บันทึกไม่สำเร็จ: ${error.message}`)]);
  const plan = await getUserPlan(userId);
  return reply(event, [flexSaveConfirm(title, date, time, '✅ บันทึกนัดหมายแล้ว!', canUsePremium(plan), data.notes || null)]);
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
async function flexMenu(userId) {
  const plan = userId ? await getUserPlan(userId) : 'free';
  const planLabel = plan === 'business' ? 'BUSINESS' : plan === 'personal' ? 'PERSONAL' : 'FREE';
  const planColor = plan === 'business' ? '#a78bfa' : plan === 'personal' ? '#93c5fd' : '#94a3b8';
  const planBg = plan === 'business' ? 'rgba(139,92,246,0.25)' : plan === 'personal' ? 'rgba(59,130,246,0.25)' : 'rgba(148,163,184,0.2)';
  const isPremium = canUsePremium(plan);
  const isBusiness = canUseBusiness(plan);

  const lockBadge = (color) => ({
    type: 'box', layout: 'vertical', flex: 0, paddingAll: '3px', paddingStart: '6px', paddingEnd: '6px',
    backgroundColor: color === 'blue' ? '#dbeafe' : '#ede9fe', cornerRadius: '20px',
    contents: [{ type: 'text', text: '🔒', size: 'xxs', color: color === 'blue' ? '#2563eb' : '#7c3aed' }],
  });

  const menuRow = (icon, title, subtitle, action, locked = false, lockColor = 'blue', highlight = null) => ({
    type: 'box', layout: 'horizontal',
    backgroundColor: locked ? '#f1f5f9' : highlight === 'blue' ? '#eff6ff' : highlight === 'purple' ? '#f5f3ff' : '#f9fafb',
    cornerRadius: '10px', paddingAll: '11px', margin: 'xs', alignItems: 'center',
    action: locked ? undefined : { type: 'message', label: title, text: action },
    contents: [
      { type: 'text', text: icon, size: 'md', flex: 0, margin: 'none' },
      { type: 'box', layout: 'vertical', flex: 1, paddingStart: '10px',
        contents: [
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: locked ? '#0f172a' : highlight === 'blue' ? '#1e40af' : highlight === 'purple' ? '#5b21b6' : '#0f172a' },
          { type: 'text', text: subtitle, size: 'xxs', color: locked ? '#64748b' : highlight === 'blue' ? '#3b82f6' : highlight === 'purple' ? '#8b5cf6' : '#64748b', margin: 'xs' },
        ],
      },
      locked ? lockBadge(lockColor) : { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
    ],
  });

  const separator = { type: 'separator', margin: 'sm' };

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
          separator,
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

// ── สร้าง Add to Calendar URLs ──
function makeCalendarUrls(title, date, time) {
  const startStr = `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
  const endDate = new Date(`${date}T${time}:00`);
  endDate.setHours(endDate.getHours() + 1);
  const endStr = `${formatDate(endDate).replace(/-/g, '')}T${String(endDate.getHours()).padStart(2,'0')}${String(endDate.getMinutes()).padStart(2,'0')}00`;
  const encodedTitle = encodeURIComponent(title);
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodedTitle}&dates=${startStr}/${endStr}`;
  const outlook = `https://outlook.live.com/calendar/0/action/compose?subject=${encodedTitle}&startdt=${date}T${time}:00&enddt=${formatDate(endDate)}T${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}:00`;
  return { google, outlook };
}

// ── FLEX: Save Confirm ──
function flexSaveConfirm(title, date, time, headerText = '✅ บันทึกนัดหมายแล้ว!', isPremium = false, notes = null) {
  const { google, outlook } = makeCalendarUrls(title, date, time);
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
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
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
              ...(notes ? [{ type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { type: 'text', text: '📝', flex: 0, size: 'sm' },
                  { type: 'text', text: notes, flex: 1, size: 'sm', color: '#6b7280', wrap: true },
                ]}] : []),
            ],
          },
          ...(isPremium ? [
            { type: 'text', text: 'เพิ่มใน Calendar ของคุณ', size: 'xs', color: '#9ca3af', align: 'center', margin: 'sm' },
            { type: 'box', layout: 'horizontal', spacing: 'sm',
              contents: [
                { type: 'button', style: 'primary', color: '#4285f4', height: 'sm', flex: 1,
                  action: { type: 'uri', label: '📅 Google', uri: google } },
                { type: 'button', style: 'primary', color: '#0078d4', height: 'sm', flex: 1,
                  action: { type: 'uri', label: '📘 Outlook', uri: outlook } },
              ],
            },
          ] : [
            { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '8px', margin: 'sm',
              contents: [{ type: 'text', text: '🔒 Add to Calendar สำหรับ Personal ขึ้นไป', size: 'xs', color: '#9ca3af', align: 'center', wrap: true }]
            },
          ]),
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
function flexReminder(apt, minutesBefore = 30) {
  return {
    type: 'flex', altText: `⏰ ${apt.title} อีก 30 นาที`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '⏰ แจ้งเตือนนัดหมาย', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: `อีก ${minutesBefore >= 1440 ? minutesBefore/1440+' วัน' : minutesBefore >= 60 ? minutesBefore/60+' ชั่วโมง' : minutesBefore+' นาที'}!`, size: 'xxl', weight: 'bold', color: '#FF6B35' },
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
      items.push({
        type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '8px',
        paddingAll: '10px', margin: 'xs',
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
          { type: 'text',
            text: apt.location ? `⏰ ${apt.start_time.slice(0,5)}  📍 ${apt.location}` : `⏰ ${apt.start_time.slice(0,5)}`,
            size: 'xs', color: '#6b7280', margin: 'xs' },
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

// ── FLEX: Select Appointment (Carousel — จัดกลุ่มตามวัน) ──
function flexSelectAppointment(apts, action) {
  const isDelete = action === 'ลบ';
  const icon = isDelete ? '🗑️' : '✏️';
  const headerColor = isDelete ? '#FF6B35' : '#06C755';
  const headerTitle = isDelete ? '🗑️ เลือกนัดที่จะลบ' : '✏️ เลือกนัดที่จะแก้ไข';
  const dayNames = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  // จัดกลุ่มตามวัน
  const groups = {};
  for (const apt of apts) {
    const d = apt.meeting_date;
    if (!groups[d]) groups[d] = [];
    groups[d].push(apt);
  }

  // สร้าง bubble แต่ละวัน (max 12 bubbles)
  const bubbles = Object.entries(groups).slice(0, 12).map(([date, dayApts]) => {
    const d = new Date(date + 'T00:00:00');
    const dayLabel = `${dayNames[d.getDay()]}ที่ ${d.getDate()} ${monthNames[d.getMonth()]}`;

    const items = dayApts.map(apt => ({
      type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px',
      paddingAll: '10px', margin: 'xs', alignItems: 'center',
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
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '12px',
        contents: [
          { type: 'text', text: headerTitle, size: 'xxs', color: '#94a3b8' },
          { type: 'text', text: dayLabel, size: 'sm', weight: 'bold', color: headerColor },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'xs', contents: items },
    };
  });

  // ถ้ามีแค่วันเดียว ส่งเป็น bubble เดี่ยว
  if (bubbles.length === 1) {
    return { type: 'flex', altText: `เลือกนัดที่จะ${action}`, contents: bubbles[0] };
  }

  // ถ้าหลายวัน ส่งเป็น carousel
  return {
    type: 'flex', altText: `เลือกนัดที่จะ${action}`,
    contents: { type: 'carousel', contents: bubbles },
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

// ── FLEX: Contact ──
function flexContact() {
  return {
    type: 'flex', altText: '💬 ติดต่อเรา',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '💬 ติดต่อเรา', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'แจ้งปัญหาการใช้งาน', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: 'ทีมงานจะติดต่อกลับภายใน 24 ชั่วโมงครับ', size: 'xs', color: '#94a3b8', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'text', text: 'เลือกหัวข้อที่ต้องการแจ้งครับ', size: 'sm', weight: 'bold', color: '#111111', margin: 'sm' },
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
            action: { type: 'message', label: 'แจ้งปัญหา', text: 'แจ้งปัญหาการใช้งาน' },
            contents: [
              { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
                contents: [
                  { type: 'text', text: '🐛', flex: 0, size: 'xl' },
                  { type: 'box', layout: 'vertical', flex: 1,
                    contents: [
                      { type: 'text', text: 'พบปัญหาการใช้งาน', size: 'sm', weight: 'bold', color: '#111111' },
                      { type: 'text', text: 'Bot ไม่ตอบ หรือตอบผิด', size: 'xs', color: '#6b7280' },
                    ]},
                  { type: 'text', text: '›', size: 'lg', color: '#d1d5db', flex: 0 },
                ]},
            ]},
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
            action: { type: 'message', label: 'แนะนำฟีเจอร์', text: 'แนะนำฟีเจอร์' },
            contents: [
              { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
                contents: [
                  { type: 'text', text: '💡', flex: 0, size: 'xl' },
                  { type: 'box', layout: 'vertical', flex: 1,
                    contents: [
                      { type: 'text', text: 'แนะนำฟีเจอร์', size: 'sm', weight: 'bold', color: '#111111' },
                      { type: 'text', text: 'อยากให้เพิ่มความสามารถ', size: 'xs', color: '#6b7280' },
                    ]},
                  { type: 'text', text: '›', size: 'lg', color: '#d1d5db', flex: 0 },
                ]},
            ]},
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
            action: { type: 'message', label: 'สอบถามแผน', text: 'สอบถามแผนและราคา' },
            contents: [
              { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
                contents: [
                  { type: 'text', text: '💳', flex: 0, size: 'xl' },
                  { type: 'box', layout: 'vertical', flex: 1,
                    contents: [
                      { type: 'text', text: 'สอบถามแผนและราคา', size: 'sm', weight: 'bold', color: '#111111' },
                      { type: 'text', text: 'Free / Personal / Business', size: 'xs', color: '#6b7280' },
                    ]},
                  { type: 'text', text: '›', size: 'lg', color: '#d1d5db', flex: 0 },
                ]},
            ]},
          { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
            action: { type: 'message', label: 'อื่นๆ', text: 'อื่นๆ' },
            contents: [
              { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
                contents: [
                  { type: 'text', text: '❓', flex: 0, size: 'xl' },
                  { type: 'box', layout: 'vertical', flex: 1,
                    contents: [
                      { type: 'text', text: 'อื่นๆ', size: 'sm', weight: 'bold', color: '#111111' },
                      { type: 'text', text: 'ติดต่อทีมงานโดยตรง', size: 'xs', color: '#6b7280' },
                    ]},
                  { type: 'text', text: '›', size: 'lg', color: '#d1d5db', flex: 0 },
                ]},
            ]},
        ],
      },
    },
  };
}

// ── User Management ──
async function getOrCreateUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('line_user_id', userId).single();
  if (data) return data;
  const { data: newUser } = await supabase.from('users').insert({ line_user_id: userId, plan: 'free' }).select().single();
  return newUser;
}

async function getUserPlan(userId) {
  const user = await getOrCreateUser(userId);
  if (!user) return 'free';
  if (user.plan !== 'free' && user.plan_expires_at) {
    const now = new Date();
    const expires = new Date(user.plan_expires_at);
    if (now > expires) {
      await supabase.from('users').update({ plan: 'free', plan_expires_at: null }).eq('line_user_id', userId);
      return 'free';
    }
  }
  return user.plan || 'free';
}

function canUsePremium(plan) {
  return plan === 'personal' || plan === 'business';
}

function canUseBusiness(plan) {
  return plan === 'business';
}


// ── FLEX: Plan ──
function flexPlan(plan, expiresAt) {
  const planNames = { free: 'Free', personal: 'Personal', business: 'Business' };
  const planColors = { free: '#06C755', personal: '#3b82f6', business: '#8b5cf6' };
  const planPrices = { free: 'ฟรีตลอด', personal: '฿30/เดือน', business: '฿199/เดือน' };
  const color = planColors[plan] || '#06C755';
  const expiry = expiresAt ? `หมดอายุ: ${new Date(expiresAt).toLocaleDateString('th-TH')}` : '';

  const freeFeatures = ['✓ เพิ่ม/ดู/ลบนัดหมาย', '✓ แจ้งเตือน 30 นาที', '✓ ดูนัดทั้งเดือน'];
  const personalFeatures = ['✓ ทุกอย่างใน Free', '✓ Add to Calendar', '✓ ส่งรูปเพื่อนัด', '✓ ตั้งเวลาแจ้งเตือนเอง (1 ครั้ง)', '✓ Export PDF/Excel', '✓ นัดซ้ำประจำ'];
  const businessFeatures = ['✓ ทุกอย่างใน Personal', '✓ แจ้งเตือนหลายช่วงต่อนัด', '✓ จัดการทีม', '✓ Web Dashboard'];

  const features = plan === 'business' ? businessFeatures : plan === 'personal' ? personalFeatures : freeFeatures;

  return {
    type: 'flex', altText: `แพลนของคุณ: ${planNames[plan]}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '👤 แพลนของคุณ', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: planNames[plan] || 'Free', size: 'xxl', weight: 'bold', color: color },
          { type: 'text', text: planPrices[plan] || 'ฟรีตลอด', size: 'sm', color: '#94a3b8', margin: 'xs' },
          expiry ? { type: 'text', text: expiry, size: 'xs', color: '#FF6B35', margin: 'xs' } : { type: 'filler' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: features.map(f => ({
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'text', text: f.startsWith('✓') ? '✓' : '✗', flex: 0, size: 'sm', color: f.startsWith('✓') ? color : '#d1d5db' },
            { type: 'text', text: f.slice(2), flex: 1, size: 'sm', color: f.startsWith('✓') ? '#111111' : '#9ca3af', wrap: true },
          ],
        })),
      },
      footer: plan === 'free' ? {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#3b82f6', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Personal ฿30/เดือน', text: 'อัปเกรด Personal' } },
          { type: 'button', style: 'primary', color: '#8b5cf6', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Business ฿199/เดือน', text: 'อัปเกรด Business' } },
        ],
      } : plan === 'personal' ? {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#8b5cf6', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Business ฿199/เดือน', text: 'อัปเกรด Business' } },
        ],
      } : { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [{ type: 'text', text: '🎉 คุณใช้แผนสูงสุดแล้วครับ!', size: 'sm', color: '#8b5cf6', align: 'center' }] },
    },
  };
}


// ── วิเคราะห์รูปภาพเพื่อนัดหมาย ──
async function handleImageAppointment(event, userId, imageBase64) {
  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  const prompt = `วันนี้คือ ${todayStr} พรุ่งนี้คือ ${tomorrowStr}

ดูรูปนี้และหาข้อมูลนัดหมาย ตอบเฉพาะ JSON เท่านั้น:
{"isAppointment":true/false,"title":"ชื่อนัด","date":"YYYY-MM-DD หรือ null","time":"HH:MM หรือ null","location":"สถานที่ หรือ null","notes":"รายละเอียดเพิ่มเติม หรือ null"}

ถ้าไม่พบข้อมูลนัดหมายในรูป ให้ isAppointment=false`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  if (!data.content || !data.content[0]) return reply(event, [flexText('❌ วิเคราะห์รูปไม่ได้ครับ ลองส่งใหม่')]);

  const text = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  const match = text.match(/{[\s\S]*}/);
  if (!match) return reply(event, [flexText('❌ ไม่พบข้อมูลนัดหมายในรูปครับ')]);

  const parsed = JSON.parse(match[0]);
  if (!parsed.isAppointment) return reply(event, [flexText('🤔 ไม่พบข้อมูลนัดหมายในรูปครับ\n\nลองถ่ายรูปใบนัด/ใบสั่งงานที่มีวันและเวลาชัดเจนนะครับ')]);

  if (!parsed.date) return reply(event, [{ type: 'text', text: `📅 พบนัด "${parsed.title}" แต่ไม่เห็นวันที่ครับ วันไหนดี?`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: 'วันนี้', text: `${parsed.title} วันนี้ ${parsed.time || ''}`.trim() } },
      { type: 'action', action: { type: 'message', label: 'พรุ่งนี้', text: `${parsed.title} พรุ่งนี้ ${parsed.time || ''}`.trim() } },
    ]}
  }]);
  if (!parsed.time) return reply(event, [{ type: 'text', text: `⏰ พบนัด "${parsed.title}" แต่ไม่เห็นเวลาครับ กี่โมง?` }]);

  return await saveAndReply(event, userId, parsed);
}

// ── ตั้งเวลาแจ้งเตือน (Personal+) ──
async function handleSetReminder(event, userId, aptId, minutesBefore) {
  const plan = await getUserPlan(userId);
  if (!canUsePremium(plan)) return reply(event, [{ type: 'text', text: '🔒 ฟีเจอร์นี้สำหรับ Personal Plan ขึ้นไปครับ' }]);

  const { data: apt } = await supabase.from('appointments').select('*').eq('id', aptId).single();
  if (!apt) return reply(event, [flexText('❌ ไม่พบนัดหมายครับ')]);

  let reminders = apt.reminders || [];

  if (canUseBusiness(plan)) {
    // Business: เพิ่มได้หลายช่วง
    if (!reminders.find(r => r.minutes === minutesBefore)) {
      reminders.push({ minutes: minutesBefore, sent: false });
    }
  } else {
    // Personal: ตั้งได้ 1 ครั้ง
    reminders = [{ minutes: minutesBefore, sent: false }];
  }

  await supabase.from('appointments').update({ reminders, reminded: false }).eq('id', aptId);

  const formatMins = (m) => m >= 1440 ? `${m/1440} วันก่อน` : m >= 60 ? `${m/60} ชั่วโมงก่อน` : `${m} นาทีก่อน`;
  const reminderList = reminders.map((r, i) => `${i+1}. ⏰ ${formatMins(r.minutes)}`).join('\n');
  const isBusiness = canUseBusiness(plan);

  const messages = [{
    type: 'text',
    text: `✅ ตั้งแจ้งเตือน "${apt.title}"\n\nแจ้งเตือนที่ตั้งไว้:\n${reminderList}`,
    quickReply: { items: [
      ...(isBusiness ? [{ type: 'action', action: { type: 'message', label: '➕ เพิ่มช่วงเวลาอีก', text: 'ตั้งแจ้งเตือน' } }] : []),
      { type: 'action', action: { type: 'message', label: '📅 กำหนดการ', text: 'กำหนดการ' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ]},
  }];
  return reply(event, messages);
}


// ── FLEX: Set Reminder Picker ──
function flexSetReminder(aptId, isBusiness) {
  const options = [
    { label: '10 นาทีก่อน', mins: 10 },
    { label: '30 นาทีก่อน', mins: 30 },
    { label: '1 ชั่วโมงก่อน', mins: 60 },
    { label: '3 ชั่วโมงก่อน', mins: 180 },
    { label: '1 วันก่อน', mins: 1440 },
    { label: '3 วันก่อน', mins: 4320 },
  ];

  return {
    type: 'flex', altText: '⏰ เลือกเวลาแจ้งเตือน',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '⏰ ตั้งเวลาแจ้งเตือน', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: isBusiness ? 'เพิ่มได้หลายช่วง' : 'เลือก 1 ช่วงเวลา', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: options.map(opt => ({
          type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '8px',
          paddingAll: '12px', alignItems: 'center',
          action: { type: 'message', label: opt.label, text: `แจ้งเตือน${opt.mins}` },
          contents: [
            { type: 'text', text: '⏰', flex: 0, size: 'sm' },
            { type: 'text', text: opt.label, flex: 1, size: 'sm', weight: 'bold', color: '#111111', margin: 'sm' },
            { type: 'text', text: '›', flex: 0, size: 'lg', color: '#d1d5db' },
          ],
        })),
      },
    },
  };
}


// ── FLEX: Select Appointment for Reminder (ไม่โชว์ UUID) ──
function flexSelectReminderApt(apts) {
  const items = apts.map(apt => ({
    type: 'box', layout: 'horizontal', backgroundColor: '#f9fafb', cornerRadius: '10px',
    paddingAll: '12px', margin: 'sm', alignItems: 'center',
    action: { type: 'message', label: apt.title, text: apt.title },
    contents: [
      { type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: apt.title, size: 'sm', weight: 'bold', color: '#111111', wrap: true },
          { type: 'text', text: `${apt.meeting_date} ${apt.start_time.slice(0,5)}`, size: 'xs', color: '#6b7280' },
        ],
      },
      { type: 'text', text: '⏰', size: 'lg', flex: 0 },
    ],
  }));

  return {
    type: 'flex', altText: 'เลือกนัดที่จะตั้งแจ้งเตือน',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [{ type: 'text', text: 'เลือกนัดที่จะตั้งแจ้งเตือนครับ', size: 'md', weight: 'bold', color: '#06C755' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
    },
  };
}


// ── Team Management ──
async function handleTeam(event, userId) {
  const plan = await getUserPlan(userId);
  if (!canUseBusiness(plan)) {
    return reply(event, [flexText('🔒 ฟีเจอร์จัดการทีมสำหรับ Business Plan เท่านั้นครับ\n\nพิมพ์ "แพลน" เพื่อดูรายละเอียดการอัปเกรด')]);
  }

  // ดึงทีมที่เป็นเจ้าของ
  const { data: ownTeams } = await supabase.from('teams').select('*, team_members(count)').eq('owner_line_id', userId);
  // ดึงทีมที่เป็นสมาชิก
  const { data: memberTeams } = await supabase.from('team_members').select('team_id, teams(id, name, owner_line_id)').eq('line_user_id', userId).neq('role', 'owner');

  return reply(event, [flexTeamMenu(ownTeams || [], memberTeams || [])]);
}

function flexTeamMenu(ownTeams, memberTeams) {
  const hasTeam = ownTeams.length > 0;
  const items = [];

  if (hasTeam) {
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
              { type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1,
                action: { type: 'message', label: '🔗 Link เชิญ', text: `link:${team.name}` } },
              { type: 'button', style: 'secondary', height: 'sm', flex: 1,
                action: { type: 'message', label: '👥 ดูสมาชิก', text: `สมาชิก:${team.name}` } },
            ]},
        ],
      });
    }
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
    items.push({
      type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '16px', margin: 'sm',
      contents: [{ type: 'text', text: 'ยังไม่มีทีมครับ\nกด "สร้างทีม" เพื่อเริ่มต้น', size: 'sm', color: '#6b7280', align: 'center', wrap: true }],
    });
  }

  return {
    type: 'flex', altText: '👥 จัดการทีม',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '👥 จัดการทีม', size: 'xs', color: '#94a3b8' },
          { type: 'text', text: 'ทีมของฉัน', size: 'xl', weight: 'bold', color: '#ffffff' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: items },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#8b5cf6', height: 'sm',
            action: { type: 'message', label: '+ สร้างทีมใหม่', text: 'สร้างทีม' } },
        ],
      },
    },
  };
}


// ── Team Invite Link ──
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
  if (error) return reply(event, [{ type: 'text', text: `✅ คุณเป็นสมาชิกทีม "${invite.teams?.name}" อยู่แล้วครับ` }]);

  return reply(event, [{ type: 'text', text: `🎉 เข้าร่วมทีม "${invite.teams?.name}" สำเร็จแล้วครับ!`, quickReply: { items: [
    { type: 'action', action: { type: 'message', label: '👥 ดูทีม', text: 'จัดการทีม' } },
  ]}}]);
}


// ── FLEX: Manage Menu ──
function flexManageMenu() {
  return {
    type: 'flex', altText: '📋 จัดการนัดหมาย',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
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
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '← กลับเมนูหลัก', text: 'เมนู' } },
        ],
      },
    },
  };
}


// ── FLEX: Text Card (แทน text ธรรมดา) ──
function flexText(text, quickReplyItems = null) {
  const lines = text.split('\n');
  const title = lines[0];
  const body = lines.slice(1).join('\n').trim();

  // กำหนดสีตาม emoji ที่ขึ้นต้น
  let headerBg = '#0f172a';
  let headerColor = '#06C755';
  if (title.startsWith('❌')) { headerColor = '#ef4444'; }
  else if (title.startsWith('✅') || title.startsWith('🎉')) { headerColor = '#06C755'; }
  else if (title.startsWith('⏰')) { headerColor = '#FF6B35'; }
  else if (title.startsWith('🔒')) { headerColor = '#8b5cf6'; }
  else if (title.startsWith('📅') || title.startsWith('📋')) { headerColor = '#3b82f6'; }
  else if (title.startsWith('✏️')) { headerColor = '#f59e0b'; }

  const msg = {
    type: 'flex', altText: title.replace(/[✅❌⏰🔒📅📋✏️🎉👥💬🗑️]/g, '').trim() || text.slice(0, 40),
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

  if (quickReplyItems) {
    return { ...msg, quickReply: { items: quickReplyItems } };
  }
  return msg;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ปฏิทินBoy Bot รันที่ port ${PORT}`));