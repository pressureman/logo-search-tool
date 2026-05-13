const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const lark = require('@larksuiteoapi/node-sdk');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const manifest = JSON.parse(fs.readFileSync('./logos/manifest.json', 'utf8'));

async function parseIntent(userMessage) {
  const logoList = manifest.logos
    .map(l => {
      const parts = l.colorParts ? `圆色+图标色可分开控制` : `可改色：${l.colorEditable}`;
      return `${l.id}（别名：${l.aliases.join('/')}，${parts}）`;
    })
    .join('\n');

  const res = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `你是一个logo助手。用户说：「${userMessage}」

可用logo列表：
${logoList}

请返回JSON，格式：{"logoId":"","format":"svg|png|pdf","size":512,"color":"#RRGGBB或null","iconColor":"#RRGGBB或null","bgColor":"#RRGGBB或null","notFound":false}
- format 默认 png，size 默认 512
- color：单色logo的颜色；对于圆形logo，是圆的背景色
- iconColor：仅对「圆色+图标色可分开控制」的logo有效，表示圆内图标的颜色
- bgColor：画布背景色（导出图片时的底色），没提就填 null
- notFound 如果找不到匹配logo就填 true
只返回JSON，不要其他文字。`,
    }],
  });

  try {
    return JSON.parse(res.content[0].text);
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

  let sharpInst = sharp(Buffer.from(svgContent)).resize(intent.size, intent.size, { fit: 'contain' });

  if (intent.bgColor) {
    sharpInst = sharpInst.flatten({ background: intent.bgColor });
  }

  if (intent.format === 'pdf') {
    const buffer = await sharpInst.pdf().toBuffer();
    return { buffer, ext: 'pdf', mime: 'application/pdf' };
  }

  const buffer = await sharpInst.png().toBuffer();
  return { buffer, ext: 'png', mime: 'image/png' };
}

async function sendLogoToFeishu(chatId, fileResult) {
  const uploadRes = await larkClient.im.image.create({
    data: {
      image_type: 'message',
      image: fileResult.buffer,
    },
  });

  await larkClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: uploadRes.data.image_key }),
    },
  });
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

  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  const event = body?.event;
  if (!event || event.message?.message_type !== 'text') {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  const userText = JSON.parse(event.message.content).text.replace(/@\S+/g, '').trim();
  const chatId = event.message.chat_id;

  try {
    const intent = await parseIntent(userText);

    if (intent.notFound) {
      await replyText(chatId, '抱歉，没有找到对应的 logo，可以告诉我更多信息吗？');
      return;
    }

    const fileResult = await processLogo(intent);
    if (!fileResult) throw new Error('logo 文件不存在');

    await sendLogoToFeishu(chatId, fileResult);
  } catch (err) {
    console.error(err);
    await replyText(chatId, '处理出错了，请稍后再试。');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Logo Bot 启动'));
