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

// chatId -> { candidates: string[], intent: object }
const pendingSelections = new Map();

function resolveSelection(userText, candidates) {
  const t = userText.trim().toLowerCase();
  const num = parseInt(t);
  if (!isNaN(num) && num >= 1 && num <= candidates.length) return candidates[num - 1];
  return candidates.find(id => id.toLowerCase() === t)
      || candidates.find(id => id.toLowerCase().includes(t) || t.includes(id.toLowerCase()))
      || null;
}

async function parseIntent(userMessage) {
  const logoList = manifest.logos
    .map(l => {
      const parts = l.colorParts ? `圆色+图标色可分开控制` : `可改色：${l.colorEditable}`;
      return `${l.id}（别名：${l.aliases.join('/')}，${parts}）`;
    })
    .join('\n');

  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `你是一个logo助手。用户说：「${userMessage}」

可用logo列表：
${logoList}

请返回JSON，格式：{"logoId":"","format":"svg|png","size":512,"color":"#RRGGBB或null","iconColor":"#RRGGBB或null","bgColor":"#RRGGBB或null","notFound":false,"ambiguous":false,"candidates":[]}
- format 默认 png，size 默认 512
- color：单色logo的颜色；对于圆形logo，是圆的背景色
- iconColor：仅对「圆色+图标色可分开控制」的logo有效，表示圆内图标的颜色
- bgColor：画布背景色（导出图片时的底色），没提就填 null
- notFound：找不到任何匹配时填 true
- ambiguous：仅当用户说的品牌/名称同时对应多个版本（如"3chat"同时匹配3chat-symbol和3chat-symbol-circle）时填 true，candidates 只列这几个相关候选，logoId 留空。如果能明确判断用户要哪一个，就直接填 logoId，不要触发 ambiguous
只返回JSON，不要其他文字。`,
    }],
  });

  try {
    return JSON.parse(res.choices[0].message.content.trim());
  } catch {
    return { notFound: true };
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

  let svgContent = fs.readFileSync(`./logos/${logo.id}.svg`, 'utf8');

  if (intent.color || intent.iconColor) {
    svgContent = replaceSvgColor(svgContent, intent, logo);
  }

  if (intent.format === 'svg') {
    return { buffer: Buffer.from(svgContent), ext: 'svg', mime: 'image/svg+xml' };
  }

  const resvg = new Resvg(svgContent, {
    fitTo: { mode: 'width', value: intent.size },
    background: intent.bgColor || undefined,
  });
  const buffer = resvg.render().asPng();
  return { buffer, ext: 'png', mime: 'image/png' };
}

async function sendLogoToFeishu(chatId, fileResult, logoId) {
  if (fileResult.ext === 'svg') {
    const uploadRes = await larkClient.im.file.create({
      data: {
        file_type: 'stream',
        file_name: `${logoId}.svg`,
        file: fileResult.buffer,
      },
    });
    const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
    if (!fileKey) throw new Error(`文件上传失败，响应：${JSON.stringify(uploadRes)}`);
    await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  } else {
    const uploadRes = await larkClient.im.image.create({
      data: {
        image_type: 'message',
        image: fileResult.buffer,
      },
    });
    const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
    if (!imageKey) throw new Error(`图片上传失败，响应：${JSON.stringify(uploadRes)}`);
    await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }
}

async function replyText(chatId, text) {
  await larkClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}

app.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('收到请求:', JSON.stringify(body));

  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  const event = body?.event;
  console.log('event:', JSON.stringify(event));
  console.log('message_type:', event?.message?.message_type);

  if (!event || event.message?.message_type !== 'text') {
    console.log('消息类型不匹配，跳过');
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  const userText = JSON.parse(event.message.content).text.replace(/@\S+/g, '').trim();
  const chatId = event.message.chat_id;

  const cancelKeywords = ['不用了', '取消', '算了', 'cancel', '不要了', 'quit'];

  try {
    // 处理待确认的版本选择
    if (pendingSelections.has(chatId)) {
      if (cancelKeywords.some(k => userText.includes(k))) {
        pendingSelections.delete(chatId);
        await replyText(chatId, '好的，已取消。有需要随时告诉我 😊');
        return;
      }
      const pending = pendingSelections.get(chatId);
      const selected = resolveSelection(userText, pending.candidates);
      if (!selected) {
        const options = pending.candidates.map((id, i) => `${i + 1}. ${id}`).join('\n');
        await replyText(chatId, `没有找到对应版本，请回复序号或名称，或回复「取消」退出：\n${options}`);
        return;
      }
      pendingSelections.delete(chatId);
      const fileResult = await processLogo({ ...pending.intent, logoId: selected });
      if (!fileResult) throw new Error('logo 文件不存在');
      await sendLogoToFeishu(chatId, fileResult, selected);
      return;
    }

    const intent = await parseIntent(userText);

    if (intent.notFound) {
      await replyText(chatId, '抱歉，没有找到对应的 logo，可以告诉我更多信息吗？');
      return;
    }

    if (intent.ambiguous && intent.candidates?.length > 1) {
      pendingSelections.set(chatId, { candidates: intent.candidates, intent });
      const options = intent.candidates.map((id, i) => `${i + 1}. ${id}`).join('\n');
      await replyText(chatId, `找到多个版本，请选择：\n${options}`);
      return;
    }

    const fileResult = await processLogo(intent);
    if (!fileResult) throw new Error('logo 文件不存在');

    await sendLogoToFeishu(chatId, fileResult, intent.logoId);
  } catch (err) {
    console.error(err);
    await replyText(chatId, '处理出错了，请稍后再试。');
  }
});

app.get('/', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
console.log('准备监听端口:', PORT);
app.listen(PORT, '0.0.0.0', () => console.log(`Logo Bot 启动，端口 ${PORT}`));
