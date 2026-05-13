const express = require('express');
const OpenAI = require('openai');
const lark = require('@larksuiteoapi/node-sdk');
const { Resvg } = require('@resvg/resvg-js');
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
${logoList}

返回JSON，格式如下，只返回JSON不要其他文字：
{
  "action": "request|confirm|cancel|select|offTopic",
  "logoId": "",
  "selectedId": "",
  "format": "svg|png",
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

- reply 的使用（其他情况留空）：
  · action=offTopic：针对用户说的内容自然回应，结尾加「需要logo素材随时找我~」
  · action=cancel：一句轻松随意的告别，如"好嘞，有需要再来找我~"
  · action=request 且存在问题时（logo不支持改色、logo不存在、颜色有歧义、有多个版本可选等）：
    用自然口语说明情况，告知能提供什么，询问是否需要或请用户进一步确认；
    如果有多个候选版本，在 reply 里列出（如"找到两个版本：\n1. 3chat-symbol\n2. 3chat-symbol-circle\n你要哪个？"）

- 其他注意：
  · 颜色必须是合法3位或6位十六进制，如果用户给的颜色格式明显不对（位数不对等），在 reply 里友好提醒
  · logo不支持改色但用户要求改色时，reply 里说明不支持、提供原版选项
  · 如果有多个候选版本，logoId 留空，reply 列出选项
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

  let svgContent = fs.readFileSync(`./logos/${logo.id}.svg`, 'utf8');
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
  return { buffer: resvg.render().asPng(), ext: 'png' };
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

  const userText = JSON.parse(event.message.content).text.replace(/@\S+/g, '').trim();
  const chatId = event.message.chat_id;

  try {
    const state = pending.get(chatId);

    // 构造上下文描述，传给 AI
    let context = null;
    if (state?.type === 'confirm') {
      context = `机器人刚才告知用户当前请求有问题（如logo不支持改色等），等待用户确认是否需要原版。`;
    } else if (state?.type === 'select') {
      context = `机器人列出了多个logo版本供用户选择：${state.candidates.join('、')}，等待用户选择。`;
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
      // AI 发现问题或需要选择，先回复用户
      const type = intent.logoId ? 'confirm' : 'select';
      const candidates = type === 'select'
        ? manifest.logos.map(l => l.id).filter(id => reply.includes(id))
        : null;
      pending.set(chatId, { type, intent, candidates });
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
