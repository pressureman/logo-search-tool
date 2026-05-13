const express = require('express');
const OpenAI = require('openai');
const lark = require('@larksuiteoapi/node-sdk');
const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
app.use(express.json());

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const manifest = JSON.parse(fs.readFileSync('./logos/manifest.json', 'utf8'));

// chatId -> { type: 'confirm'|'select', intent, candidates? }
const pending = new Map();
// 已处理的 message_id，防飞书重复推送
const processed = new Set();

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

async function parseIntent(userMessage, context = null) {
  const logoList = manifest.logos
    .map(l => {
      const colorNote = l.colorParts
        ? '支持分别指定圆色和图标色'
        : l.colorEditable ? '支持改色' : '不支持改色（固定多色）';
      return `${l.id}（别名：${l.aliases.join('/')}，${colorNote}）`;
    })
    .join('\n');

  // 预计算：哪些 alias 对应多个 logo（用于提示 AI）
  const aliasGroups = {};
  manifest.logos.forEach(l => {
    l.aliases.forEach(a => {
      const key = a.toLowerCase();
      if (!aliasGroups[key]) aliasGroups[key] = new Set();
      aliasGroups[key].add(l.id);
    });
  });
  const sharedAliases = Object.entries(aliasGroups)
    .filter(([, ids]) => ids.size > 1)
    .map(([alias, ids]) => `"${alias}" → [${[...ids].join(', ')}]`)
    .join('；');
  const aliasNote = sharedAliases
    ? `\n【多版本别名映射】以下别名对应多个logo版本，用户使用这些词时必须触发版本选择：\n${sharedAliases}`
    : '';

  const contextSection = context
    ? `\n【当前对话状态】\n${context}\n用户的回复需要结合此状态理解。\n`
    : '';


  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `你是公司内部的logo素材助手，说话自然随意，像靠谱的同事。${contextSection}
用户说：「${userMessage}」

可用logo列表：
${logoList}${aliasNote}

返回JSON，格式如下，只返回JSON不要其他文字：
{
  "action": "request|confirm|cancel|select|offTopic",
  "logoId": "",
  "selectedId": "",
  "candidates": [],
  "format": "svg|png|jpg|webp",
  "size": 512,
  "color": "#RRGGBB或null",
  "iconColor": "#RRGGBB或null",
  "bgColor": "#RRGGBB或null",
  "reply": ""
}

各字段说明：
- action：
  · request：用户在请求logo（新请求或重新请求）
  · confirm：用户确认接受当前状态下机器人提供的方案（如"要""好""发吧"）
  · cancel：用户想取消或不需要了
  · select：用户在选择某个版本（填 selectedId 为对应 logoId）
  · offTopic：与logo无关的闲聊

【系统能力边界 - 严格遵守】
支持的格式：SVG、PNG、JPG、WEBP。不支持：PDF、GIF 及其他格式。
只支持单色替换（一个纯色 hex 值），不支持：渐变、多色、透明度、滤镜、阴影等效果。
用户请求不支持的格式或效果时，必须在 reply 里如实说明，告知支持什么，询问是否改用支持的方案。
绝对不能在 reply 里承诺会实现不支持的格式或效果。

- reply 的使用规则（其他情况留空）：
  · action=offTopic：针对用户说的内容自然回应，结尾加「需要logo素材随时找我~」
  · action=cancel：一句轻松随意的告别，如"好嘞，有需要再来找我~"
  · action=request 且存在问题时，用自然口语说明原因，明确告知能提供什么（原版 or 单色版），询问是否需要：
    - 不支持的格式（PDF/JPG等）→ 说明只支持 SVG 和 PNG，问要哪个
    - 不支持的颜色效果（渐变/多色等）→ 说明不支持，问要不要改单色，可以建议一个接近的色号
    - 颜色格式不合法 → 友好提醒正确格式（3位或6位十六进制）
    - logo不支持改色 → 说明是固定多色版本，问要不要原版
    - 有多个候选版本 → 列出选项，candidates 填所有候选 logoId
  · 存在问题时 color/iconColor 必须填 null，不能填一个"大概"的颜色去蒙混
  · 如果有多个候选版本，logoId 留空，candidates 填入所有候选 logoId
  · format 默认 png，size 默认 512`,
    }],
  });

  try {
    const parsed = JSON.parse(res.choices[0].message.content.trim());
    console.log('intent:', JSON.stringify(parsed));
    return parsed;
  } catch {
    return { action: 'request', reply: '没太理解你的意思，能再说一遍吗~' };
  }
}

function swapColor(svg, oldColor, newColor) {
  const esc = oldColor.replace(/#/g, '\\#');
  return svg
    .replace(new RegExp(`fill="${esc}"`, 'gi'), `fill="${newColor}"`)
    .replace(new RegExp(`fill:${esc}`, 'gi'), `fill:${newColor}`)
    .replace(new RegExp(`stroke="${esc}"`, 'gi'), `stroke="${newColor}"`)
    .replace(new RegExp(`stroke:${esc}`, 'gi'), `stroke:${newColor}`);
}

function replaceSvgColor(svgContent, intent, logo) {
  if (!logo.colorEditable) return svgContent;
  let result = svgContent;
  if (logo.colorParts) {
    if (intent.color)     result = swapColor(result, logo.colorParts.circle, intent.color);
    if (intent.iconColor) result = swapColor(result, logo.colorParts.icon,   intent.iconColor);
  } else if (intent.color) {
    logo.colorNodes.forEach(old => { result = swapColor(result, old, intent.color); });
  }
  return result;
}

async function processLogo(intent) {
  const logo = manifest.logos.find(l => l.id === intent.logoId);
  if (!logo) return null;

  // hex 格式安全检查（兜底，AI 应已拦截）
  if (intent.color && !HEX_RE.test(intent.color)) intent.color = null;
  if (intent.iconColor && !HEX_RE.test(intent.iconColor)) intent.iconColor = null;

  let svgContent = fs.readFileSync(`./logos/${logo.path}`, 'utf8');
  if (intent.color || intent.iconColor) {
    svgContent = replaceSvgColor(svgContent, intent, logo);
  }

  if (intent.format === 'svg') {
    return { buffer: Buffer.from(svgContent), ext: 'svg' };
  }

  const resvg = new Resvg(svgContent, {
    fitTo: { mode: 'width', value: intent.size || 512 },
    background: intent.bgColor || undefined,
  });
  const pngBuffer = resvg.render().asPng();

  const fmt = intent.format?.toLowerCase();
  if (fmt === 'jpg' || fmt === 'jpeg') {
    const buffer = await sharp(pngBuffer).jpeg({ quality: 95 }).toBuffer();
    return { buffer, ext: 'jpg' };
  }
  if (fmt === 'webp') {
    const buffer = await sharp(pngBuffer).webp({ quality: 95 }).toBuffer();
    return { buffer, ext: 'webp' };
  }

  return { buffer: pngBuffer, ext: 'png' };
}

async function sendLogoToFeishu(chatId, fileResult, logoId) {
  if (fileResult.ext === 'svg') {
    const uploadRes = await larkClient.im.file.create({
      data: { file_type: 'stream', file_name: `${logoId}.svg`, file: fileResult.buffer },
    });
    const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
    if (!fileKey) throw new Error(`文件上传失败：${JSON.stringify(uploadRes)}`);
    await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    });
  } else {
    const uploadRes = await larkClient.im.image.create({
      data: { image_type: 'message', image: fileResult.buffer },
    });
    const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
    if (!imageKey) throw new Error(`图片上传失败：${JSON.stringify(uploadRes)}`);
    await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    });
  }
}

async function replyText(chatId, text) {
  await larkClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  });
}

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });

  const event = body?.event;
  if (!event || event.message?.message_type !== 'text') return res.sendStatus(200);

  res.sendStatus(200);

  const msgId = event.message?.message_id;
  if (msgId) {
    if (processed.has(msgId)) return;
    processed.add(msgId);
    if (processed.size > 500) {
      const first = processed.values().next().value;
      processed.delete(first);
    }
  }

  const userText = JSON.parse(event.message.content).text.replace(/@\S+/g, '').trim();
  const chatId = event.message.chat_id;

  try {
    const state = pending.get(chatId);

    // 构造上下文描述，传给 AI
    let context = null;
    if (state?.type === 'confirm') {
      context = `机器人刚才告知用户"${state.intent.logoId}"这个logo有问题（如不支持改色），询问是否需要原版，正在等待用户确认。用户任何表示同意的回复（包括"要""好""行""发吧""可以""ok"等）action 返回 confirm；拒绝或取消则返回 cancel。`;
    } else if (state?.type === 'select') {
      const list = state.candidates.map((id, i) => `${i + 1}. ${id}`).join('、');
      context = `机器人列出了多个logo版本：${list}，正在等待用户选择。用户回复数字（"1""1.""第一个"等）或版本名时，action 必须返回 select，selectedId 填对应 logoId（第1个=${state.candidates[0]}，第2个=${state.candidates[1] ?? ''}）。`;
    }

    const intent = await parseIntent(userText, context);
    const { action, reply } = intent;

    if (action === 'offTopic' || action === 'cancel') {
      pending.delete(chatId);
      if (reply) await replyText(chatId, reply);
      return;
    }

    if (action === 'confirm' && state?.type === 'confirm') {
      pending.delete(chatId);
      const stripped = { ...state.intent, color: null, iconColor: null };
      const fileResult = await processLogo(stripped);
      if (!fileResult) throw new Error('logo 文件不存在');
      await sendLogoToFeishu(chatId, fileResult, stripped.logoId);
      return;
    }

    if (action === 'select' && state?.type === 'select') {
      pending.delete(chatId);
      const fileResult = await processLogo({ ...state.intent, logoId: intent.selectedId });
      if (!fileResult) throw new Error('logo 文件不存在');
      await sendLogoToFeishu(chatId, fileResult, intent.selectedId);
      return;
    }

    // action === 'request'
    if (reply) {
      const hasCandidates = intent.candidates?.length > 1;
      const type = hasCandidates ? 'select' : 'confirm';
      pending.set(chatId, { type, intent, candidates: intent.candidates ?? [] });
      await replyText(chatId, reply);
      return;
    }

    if (!intent.logoId) {
      await replyText(chatId, '没找到对应的logo，能说得更具体些吗~');
      return;
    }

    pending.delete(chatId);
    const fileResult = await processLogo(intent);
    if (!fileResult) throw new Error('logo 文件不存在');
    await sendLogoToFeishu(chatId, fileResult, intent.logoId);

  } catch (err) {
    console.error(err);
    await replyText(chatId, '出了点问题，稍后再试试吧~');
  }
});

app.get('/', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
console.log('准备监听端口:', PORT);
app.listen(PORT, '0.0.0.0', () => console.log(`Logo Bot 启动，端口 ${PORT}`));
