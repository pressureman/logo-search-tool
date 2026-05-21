const express = require('express');
const OpenAI = require('openai');
const lark = require('@larksuiteoapi/node-sdk');
const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');
const JSZip = require('jszip');
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

// chatId -> { type: 'confirm'|'select'|'online_select'|'online_options', ... }
const pending = new Map();
// 已处理的 message_id，防飞书重复推送
const processed = new Set();

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// 颜色名称 → hex（兜底，不依赖 AI 转换）
const COLOR_NAME_MAP = {
  '红': '#FF0000', '红色': '#FF0000', 'red': '#FF0000',
  '蓝': '#0066FF', '蓝色': '#0066FF', 'blue': '#0066FF',
  '绿': '#00AA00', '绿色': '#00AA00', 'green': '#00AA00',
  '黄': '#FFCC00', '黄色': '#FFCC00', 'yellow': '#FFCC00',
  '橙': '#FF6600', '橙色': '#FF6600', 'orange': '#FF6600',
  '紫': '#8800CC', '紫色': '#8800CC', 'purple': '#8800CC',
  '粉': '#FF88CC', '粉色': '#FF88CC', 'pink': '#FF88CC',
  '白': '#FFFFFF', '白色': '#FFFFFF', 'white': '#FFFFFF',
  '黑': '#000000', '黑色': '#000000', 'black': '#000000',
  '灰': '#888888', '灰色': '#888888', 'gray': '#888888', 'grey': '#888888',
  '金': '#FFD700', '金色': '#FFD700', 'gold': '#FFD700',
  '棕': '#8B4513', '棕色': '#8B4513', 'brown': '#8B4513',
};

// 解析颜色：已是合法 hex 直接返回，否则查颜色名映射表
function resolveColor(raw) {
  if (!raw) return null;
  if (HEX_RE.test(raw)) return raw;
  return COLOR_NAME_MAP[raw.trim().toLowerCase()] ?? null;
}

// 从 AI 返回内容中提取 JSON（兼容 markdown 代码块、前后多余文字等）
function extractJSON(content) {
  const text = content.trim();
  // 直接解析
  try { return JSON.parse(text); } catch {}
  // 去掉 ```json ... ``` 或 ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  // 提取第一个 {...} 块
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch {} }
  return null;
}

// ─── DeepSeek 调用封装（503/429 自动重试）─────────────────────────────────────
async function callDeepSeek(params, retries = 2, delayMs = 2000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await deepseek.chat.completions.create(params);
      // 空 content 也视为需要重试（DeepSeek 偶发返回空响应）
      const content = res.choices?.[0]?.message?.content;
      if (!content) {
        if (attempt < retries) {
          console.log(`[DeepSeek] 空响应，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        console.error('[DeepSeek] 多次重试后仍返回空响应');
      }
      return res;
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 503 || status === 429;
      if (retryable && attempt < retries) {
        console.log(`[DeepSeek] ${status} 过载，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

// ─── 本地 Logo 意图解析 ────────────────────────────────────────────────────────

async function parseIntent(userMessage, context = null) {
  const logoList = manifest.logos
    .map(l => {
      const colorNote = l.colorParts
        ? '支持分别指定圆色和图标色'
        : l.colorEditable ? '支持改色' : '不支持改色（固定多色）';
      return `${l.id}（别名：${l.aliases.join('/')}，${colorNote}）`;
    })
    .join('\n');

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

  const res = await callDeepSeek({
    model: 'deepseek-v4-flash',
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
  "brandHint": "",
  "selectedId": "",
  "selectedIds": [],
  "candidates": [],
  "format": "svg|png|jpg|webp",
  "size": 512,
  "color": "#RRGGBB或null",
  "iconColor": "#RRGGBB或null",
  "bgColor": "#RRGGBB或null",
  "reply": ""
}

各字段说明：
- brandHint：当 logoId 为空时（本地库没有该logo），填入用户意图中的品牌名称，只保留品牌名，去掉"logo""图标""svg""png""webp""jpg"等格式词和颜色词及动词；若 logoId 已有值则留空。
- action：
  · request：用户在请求logo（新请求或重新请求）
  · confirm：用户确认接受当前状态下机器人提供的方案（如"要""好""发吧"）
  · cancel：用户想取消或不需要了
  · select：用户在选择某个版本；若用户要全部（"都要""全给我"等），selectedIds 填所有候选 logoId，selectedId 留空；否则 selectedId 填对应 logoId，selectedIds 留空
  · offTopic：与logo无关的闲聊

【系统能力边界 - 严格遵守】
支持的格式：SVG、PNG、JPG、WEBP。不支持：PDF、GIF 及其他格式。
只支持单色替换（一个纯色 hex 值），不支持：渐变、多色、透明度、滤镜、阴影等效果。
用户说颜色名称（如"红色""蓝色""黑色"）时，直接转换为对应十六进制色号填入 color 字段（如红色→#FF0000、蓝色→#0066FF、黑色→#000000），不需要再询问用户。
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
  · format 默认 png，size 默认 512
  · 【重要】如果用户请求的 logo 不在可用列表中，reply 必须留空，logoId 留空，系统会自动去在线搜索，不要自己说"找不到"`,
    }],
  });

  const rawContent = res.choices[0].message.content;
  const finishReason = res.choices[0].finish_reason;
  const parsed = extractJSON(rawContent);
  if (!parsed) {
    console.error(`[parseIntent] JSON提取失败，finish_reason: ${finishReason}，原始内容:`, rawContent);
    return { action: 'request', reply: '没太理解你的意思，能再说一遍吗~' };
  }
  parsed.color = resolveColor(parsed.color);
  parsed.iconColor = resolveColor(parsed.iconColor);
  console.log('intent:', JSON.stringify(parsed));
  return parsed;
}

// ─── 本地 SVG 处理 ─────────────────────────────────────────────────────────────

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

// ─── 在线搜索：工具函数 ────────────────────────────────────────────────────────

async function generateReply(prompt) {
  const res = await callDeepSeek({
    model: 'deepseek-v4-flash',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content.trim();
}

async function translateToSearchSlugs(userInput) {
  const res = await callDeepSeek({
    model: 'deepseek-v4-flash',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `从用户输入中提取品牌名称，转换为 SimpleIcons 的 slug 格式（全小写，去空格和特殊字符）。
【重要】先去掉"logo"、"图标"、"标志"、"symbol"、"icon"等无关词，只保留品牌名本身。
用户输入：「${userInput}」
返回JSON，只返回JSON不要其他文字：{"brandName": "英文品牌名", "slugs": ["slug1", "slug2"]}
slugs 最多3个，从最可能到最不可能排序。例如"微信logo"→{"brandName":"WeChat","slugs":["wechat","weixin"]}`,
    }],
  });
  try {
    return extractJSON(res.choices[0].message.content);
  } catch {
    return null;
  }
}

const SI_BASE = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons';

async function checkSimpleIconsSlugs(slugs) {
  const results = await Promise.all(
    slugs.map(async slug => {
      try {
        const res = await fetch(`${SI_BASE}/${slug}.svg`, { method: 'HEAD' });
        return res.ok ? slug : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function searchWikimedia(brandName) {
  try {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(brandName + ' logo')}&srnamespace=6&srlimit=10&format=json&origin=*`;
    const res = await fetch(searchUrl);
    const data = await res.json();
    const files = (data?.query?.search ?? []).map(r => r.title);
    if (!files.length) return [];

    const aiRes = await callDeepSeek({
      model: 'deepseek-v4-flash',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `从以下 Wikimedia Commons 文件列表中，选出最可能是"${brandName}"官方 logo 的1~3个，优先选 SVG 格式。
文件列表：
${files.join('\n')}
返回JSON，只返回JSON：{"candidates": [{"title": "File:xxx.svg", "description": "简短说明"}]}`,
      }],
    });
    const parsed = extractJSON(aiRes.choices[0].message.content);
    return parsed?.candidates ?? [];
  } catch {
    return [];
  }
}

async function getWikimediaFileUrl(title) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|mime&format=json&origin=*`;
    const res = await fetch(url);
    const data = await res.json();
    const pages = Object.values(data?.query?.pages ?? {});
    const info = pages[0]?.imageinfo?.[0];
    return info ? { url: info.url, mime: info.mime } : null;
  } catch {
    return null;
  }
}

function analyzeOnlineSvg(svgText, source) {
  // 嵌入位图
  if (/<image[\s>]/i.test(svgText)) {
    return { colorEditable: false, isBitmap: true, colorNodes: [] };
  }
  // SimpleIcons 规范保证单色，colorNodes 留空表示用根标签注入颜色
  if (source === 'simpleicons') {
    return { colorEditable: true, isBitmap: false, colorNodes: [] };
  }
  // Wikimedia：先检查渐变/pattern
  if (/<(linearGradient|radialGradient|pattern)[\s>]/i.test(svgText) ||
      /fill="url\(#/i.test(svgText) ||
      /stroke="url\(#/i.test(svgText)) {
    return { colorEditable: false, isBitmap: false, colorNodes: [] };
  }
  // 提取所有色值：属性和 style 内联两种写法
  const IGNORE = new Set(['#ffffff', '#fff', '#ffffffff']);
  const allColors = [
    ...[...svgText.matchAll(/fill="(#[0-9a-f]{3,6})"/gi)].map(m => m[1].toLowerCase()),
    ...[...svgText.matchAll(/stroke="(#[0-9a-f]{3,6})"/gi)].map(m => m[1].toLowerCase()),
    ...[...svgText.matchAll(/style="[^"]*fill\s*:\s*(#[0-9a-f]{3,6})/gi)].map(m => m[1].toLowerCase()),
    ...[...svgText.matchAll(/style="[^"]*stroke\s*:\s*(#[0-9a-f]{3,6})/gi)].map(m => m[1].toLowerCase()),
  ].filter(c => !IGNORE.has(c));
  const unique = [...new Set(allColors)];
  if (unique.length === 1) {
    return { colorEditable: true, isBitmap: false, colorNodes: unique };
  }
  return { colorEditable: false, isBitmap: false, colorNodes: [] };
}

async function downloadAndAnalyze(candidate) {
  const res = await fetch(candidate.svgUrl);
  if (!res.ok) throw new Error(`下载失败: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  let { fileType } = candidate;
  let colorEditable = false;
  let colorNodes = [];
  let maxSize = null;
  let isBitmap = false;

  if (fileType === 'svg') {
    const svgText = fileBuffer.toString('utf8');
    const analysis = analyzeOnlineSvg(svgText, candidate.source);
    colorEditable = analysis.colorEditable;
    colorNodes = analysis.colorNodes;
    isBitmap = analysis.isBitmap;
    if (isBitmap) {
      fileType = 'png';
      try { const meta = await sharp(fileBuffer).metadata(); maxSize = meta.width; } catch {}
    }
  } else {
    isBitmap = true;
    try { const meta = await sharp(fileBuffer).metadata(); maxSize = meta.width; } catch {}
  }

  return { ...candidate, fileBuffer, fileType, colorEditable, colorNodes, maxSize, isBitmap };
}

async function processOnlineLogo(selected, intent) {
  const { fileBuffer, fileType, colorEditable, colorNodes, maxSize } = selected;
  const fmt = (intent.format || 'png').toLowerCase();
  const requestedSize = intent.size || 512;
  const size = maxSize ? Math.min(requestedSize, maxSize) : requestedSize;

  if (fileType === 'svg' && !selected.isBitmap) {
    let svgText = fileBuffer.toString('utf8');
    if (colorEditable && intent.color && HEX_RE.test(intent.color)) {
      if (colorNodes.length === 0) {
        // SimpleIcons 等无显式 fill 的 SVG：直接在根标签注入颜色
        svgText = svgText.replace(/<svg\b/, `<svg fill="${intent.color}"`);
      } else {
        colorNodes.forEach(oldColor => { svgText = swapColor(svgText, oldColor, intent.color); });
      }
    }
    if (fmt === 'svg') return { buffer: Buffer.from(svgText), ext: 'svg' };

    const resvg = new Resvg(svgText, {
      fitTo: { mode: 'width', value: size },
      background: intent.bgColor || undefined,
    });
    const pngBuf = resvg.render().asPng();

    if (fmt === 'jpg' || fmt === 'jpeg') {
      return { buffer: await sharp(pngBuf).jpeg({ quality: 95 }).toBuffer(), ext: 'jpg' };
    }
    if (fmt === 'webp') {
      return { buffer: await sharp(pngBuf).webp({ quality: 95 }).toBuffer(), ext: 'webp' };
    }
    return { buffer: pngBuf, ext: 'png' };
  } else {
    // 位图：sharp 处理，不超过原始尺寸
    let sharpInst = sharp(fileBuffer).resize(size, null, { withoutEnlargement: true });
    if (fmt === 'jpg' || fmt === 'jpeg') {
      return { buffer: await sharpInst.jpeg({ quality: 95 }).toBuffer(), ext: 'jpg' };
    }
    if (fmt === 'webp') {
      return { buffer: await sharpInst.webp({ quality: 95 }).toBuffer(), ext: 'webp' };
    }
    return { buffer: await sharpInst.png().toBuffer(), ext: 'png' };
  }
}

async function parseOnlineOptions(userText, selected, intent) {
  const res = await callDeepSeek({
    model: 'deepseek-v4-flash',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `用户正在确认在线logo的输出参数。${selected.colorEditable ? '支持改色。' : '不支持改色。'}${selected.maxSize ? `最大尺寸${selected.maxSize}px。` : ''}
用户说：「${userText}」
返回JSON，只返回JSON：{"action": "confirm|cancel", "color": "#RRGGBB或null", "size": 512, "format": "png|jpg|webp|svg"}
- action=confirm：用户接受（包括"好""发吧""默认就行"等）
- action=cancel：用户取消
- color：${selected.colorEditable ? '用户指定了颜色（包括颜色名称如"蓝色""红色"等），必须转换为十六进制色号（如#0066FF），否则填null' : '固定null'}
- size：默认${selected.maxSize || 512}${selected.maxSize ? `，不超过${selected.maxSize}` : ''}
- format：默认png`,
    }],
  });
  try {
    const parsed = extractJSON(res.choices[0].message.content);
    const rawColor = parsed.color;          // 保留 AI 原始返回值
    parsed.color = resolveColor(rawColor);
    parsed._rawColor = rawColor;            // 传给调用方做判断
    console.log('[online_options] parsed:', JSON.stringify(parsed));
    return parsed;
  } catch {
    return { action: 'confirm', color: null, _rawColor: null, size: intent.size || 512, format: intent.format || 'png' };
  }
}

// ─── 在线搜索：主流程 ──────────────────────────────────────────────────────────

async function downloadAndAskOptions(chatId, candidate, intent) {
  let selected;
  try {
    selected = await downloadAndAnalyze(candidate);
  } catch (err) {
    console.error('下载失败', err);
    await replyText(chatId, await generateReply(`你是logo素材助手，在线找到了logo但下载失败了。自然地告知用户，建议稍后再试或换个说法。`));
    return;
  }

  const sourceLabel = candidate.source === 'simpleicons' ? 'SimpleIcons' : 'Wikimedia Commons';
  const userWantsColor = intent.color && HEX_RE.test(intent.color);

  // 不支持改色 但用户指定了颜色 → 告知并询问是否要原版
  if (!selected.colorEditable && userWantsColor) {
    const reply = await generateReply(
      `你是logo素材助手，在 ${sourceLabel} 找到了"${candidate.slug}"logo，但这个logo是固定多色版本，不支持改色。用自然语言告知用户，问他要不要原版。结尾注明「此素材来自 ${sourceLabel}，非公司内部素材库」。语气随意。`
    );
    pending.set(chatId, { type: 'online_options', selected, intent: { ...intent, color: null } });
    await replyText(chatId, reply);
    return;
  }

  // 支持改色 且 用户已给合法颜色，或 不支持改色 且 用户没提颜色 → 直接处理
  if ((selected.colorEditable && userWantsColor) || (!selected.colorEditable && !userWantsColor)) {
    const finalIntent = {
      ...intent,
      color: selected.colorEditable ? intent.color : null,
      size: intent.size || 512,
      format: intent.format || 'png',
    };
    await replyText(chatId, `此素材来自 ${sourceLabel}，非公司内部素材库`);
    const fileResult = await processOnlineLogo(selected, finalIntent);
    const safeId = candidate.slug.replace(/[^a-zA-Z0-9\-_]/g, '_');
    await sendLogoToFeishu(chatId, fileResult, safeId);
    return;
  }

  // 支持改色 但 颜色未指定 → 询问用户
  const colorDesc = selected.colorEditable ? '支持改色（可指定颜色）' : '固定多色（不支持改色）';
  const sizeDesc = selected.maxSize ? `原图最大 ${selected.maxSize}px` : '矢量图，支持任意尺寸';
  const reply = await generateReply(
    `你是logo素材助手，在 ${sourceLabel} 找到了用户想要的"${candidate.slug}"logo。${colorDesc}，${sizeDesc}，默认发 PNG。用自然语言询问用户是否需要指定颜色/尺寸/格式，或直接按默认发送。结尾注明「此素材来自 ${sourceLabel}，非公司内部素材库」。语气自然随意，不要感叹号。`
  );
  pending.set(chatId, { type: 'online_options', selected, intent });
  await replyText(chatId, reply);
}

async function searchOnlineAndReply(chatId, userInput, intent) {
  // 优先用 brandHint（AI 已提取好的品牌名），避免 svg/颜色等词干扰 slug 生成
  const searchInput = intent.brandHint || userInput;

  let translated = await translateToSearchSlugs(searchInput);
  // 若 JSON 解析偶发失败，重试一次
  if (!translated) {
    console.log(`[在线搜索] translateToSearchSlugs 返回 null，重试一次（input: ${searchInput}）`);
    translated = await translateToSearchSlugs(searchInput);
  }
  if (!translated) {
    await replyText(chatId, await generateReply(`你是logo素材助手，本地库没找到用户要的logo，在线翻译也失败了。自然地告知找不到，建议换个说法。`));
    return;
  }

  const { brandName, slugs } = translated;
  console.log(`在线搜索：${searchInput} → ${brandName}，slugs: ${slugs.join(', ')}`);

  // SimpleIcons
  const foundSlugs = await checkSimpleIconsSlugs(slugs);
  let candidates = foundSlugs.map(slug => ({
    slug,
    source: 'simpleicons',
    svgUrl: `${SI_BASE}/${slug}.svg`,
    fileType: 'svg',
    description: `${slug}（SimpleIcons）`,
  }));

  // Wikimedia 兜底
  if (candidates.length === 0) {
    const wikiCandidates = await searchWikimedia(brandName);
    for (const c of wikiCandidates) {
      const fileInfo = await getWikimediaFileUrl(c.title);
      if (!fileInfo) continue;
      const rawExt = fileInfo.url.split('.').pop().toLowerCase().split('?')[0];
      const extMap = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', svg: 'svg' };
      const fileType = extMap[rawExt] ?? null;
      if (!fileType) continue;
      candidates.push({
        slug: c.title.replace('File:', ''),
        source: 'wikimedia',
        svgUrl: fileInfo.url,
        fileType,
        description: `${c.title.replace('File:', '')}（Wikimedia，${c.description}）`,
      });
    }
  }

  if (candidates.length === 0) {
    const reply = await generateReply(
      `你是logo素材助手，用户想要"${userInput}"的logo，本地库、SimpleIcons 和 Wikimedia Commons 都没找到。自然地告知找不到，可以建议用户提供品牌英文名或官方名称再试试。`
    );
    await replyText(chatId, reply);
    return;
  }

  if (candidates.length === 1) {
    await downloadAndAskOptions(chatId, candidates[0], intent);
    return;
  }

  // 多个候选，让用户选
  const candidateDesc = candidates.map((c, i) => `${i + 1}. ${c.description}`).join('；');
  const reply = await generateReply(
    `你是logo素材助手，在线找到"${brandName}"有${candidates.length}个版本：${candidateDesc}。用自然语言列出让用户选一个，语气随意。`
  );
  pending.set(chatId, { type: 'online_select', candidates, intent });
  await replyText(chatId, reply);
}

// ─── 飞书消息发送 ──────────────────────────────────────────────────────────────

async function sendZipToFeishu(chatId, zipBuffer, filename) {
  const uploadRes = await larkClient.im.file.create({
    data: { file_type: 'stream', file_name: filename, file: zipBuffer },
  });
  const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
  if (!fileKey) throw new Error(`ZIP上传失败：${JSON.stringify(uploadRes)}`);
  await larkClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
  });
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

// ─── Webhook 主处理 ────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });

  const event = body?.event;
  if (!event) return res.sendStatus(200);

  const msgType = event.message?.message_type;
  if (msgType && msgType !== 'text') {
    res.sendStatus(200);
    const chatId = event.message?.chat_id;
    if (!chatId) return;
    try {
      const typeLabel = { image: '图片', file: '文件', audio: '语音', sticker: '表情', post: '富文本' }[msgType] || '该类型消息';
      const reply = await generateReply(
        `你是公司内部logo素材助手，说话自然随意像靠谱同事。用户刚发了一条${typeLabel}，但你只能处理文字消息。用一句话自然地告知用户，引导他用文字告诉你要哪个logo。不要用感叹号，不要生硬。`
      );
      await replyText(chatId, reply);
    } catch (err) {
      console.error('非文本消息回复失败', err);
    }
    return;
  }

  res.sendStatus(200);

  if (!event.message?.content) return; // 非消息事件（已读回执、reaction 等），直接忽略

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

    // ── 在线搜索：用户从多候选中选择 ──
    if (state?.type === 'online_select') {
      const candidates = state.candidates;
      const listDesc = candidates.map((c, i) => `${i + 1}=${c.slug}`).join('，');
      const selectRes = await callDeepSeek({
        model: 'deepseek-v4-flash',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `候选列表：${listDesc}。用户说「${userText}」，选的是第几个（0-based index）？返回JSON：{"index": 0}，不确定则返回{"index": -1}`,
        }],
      });
      let idx = -1;
      try { idx = (extractJSON(selectRes.choices[0].message.content) ?? {}).index ?? -1; } catch {}

      if (idx < 0 || idx >= candidates.length) {
        const reply = await generateReply(
          `你是logo素材助手，用户需要从${candidates.length}个版本里选一个，但没听清楚选了哪个。自然地再问一次。`
        );
        await replyText(chatId, reply);
        return; // 保留 pending 状态
      }

      pending.delete(chatId);
      await downloadAndAskOptions(chatId, candidates[idx], state.intent);
      return;
    }

    // ── 在线搜索：用户确认参数选项 ──
    if (state?.type === 'online_options') {
      const options = await parseOnlineOptions(userText, state.selected, state.intent);

      if (options.action === 'cancel') {
        pending.delete(chatId);
        const reply = await generateReply(`你是logo素材助手，用户取消了logo请求。用轻松随意的一句话告别。`);
        await replyText(chatId, reply);
        return;
      }

      // 用户指定了颜色但无法识别（不是合法 hex 且不在颜色名映射表中）
      if (state.selected.colorEditable && options._rawColor && !options.color) {
        const reply = await generateReply(
          `你是logo素材助手，用户想把logo改成"${options._rawColor}"这个颜色，但我没法识别这个颜色名称。用自然语言告知，请用户提供十六进制色号（比如 #FF0000），语气随意，一句话就够。`
        );
        await replyText(chatId, reply);
        return; // 保留 pending 状态，等用户重新输入
      }

      pending.delete(chatId);
      const finalIntent = {
        ...state.intent,
        color: options.color ?? state.intent.color,
        size: options.size || state.intent.size || 512,
        format: options.format || state.intent.format || 'png',
      };
      const fileResult = await processOnlineLogo(state.selected, finalIntent);
      const safeId = state.selected.slug.replace(/[^a-zA-Z0-9\-_]/g, '_');
      await sendLogoToFeishu(chatId, fileResult, safeId);
      return;
    }

    // ── 构造本地上下文 ──
    let context = null;
    if (state?.type === 'confirm') {
      context = `机器人刚才告知用户"${state.intent.logoId}"这个logo有问题（如不支持改色），询问是否需要原版，正在等待用户确认。用户任何表示同意的回复（包括"要""好""行""发吧""可以""ok"等）action 返回 confirm；拒绝或取消则返回 cancel。`;
    } else if (state?.type === 'select') {
      const list = state.candidates.map((id, i) => `${i + 1}. ${id}`).join('、');
      context = `机器人列出了多个logo版本：${list}，正在等待用户选择。用户回复数字（"1""1.""第一个"等）或版本名时，action 必须返回 select，selectedId 填对应 logoId（第1个=${state.candidates[0]}，第2个=${state.candidates[1] ?? ''}）。若用户说"都要""全部""全给我"等，selectedIds 填所有候选 logoId：[${state.candidates.map(id => `"${id}"`).join(', ')}]，selectedId 留空。`;
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
      if (!stripped.logoId) {
        await replyText(chatId, '没找到对应的logo，能再说一下你要哪个~');
        return;
      }
      const fileResult = await processLogo(stripped);
      if (!fileResult) throw new Error('logo 文件不存在');
      await sendLogoToFeishu(chatId, fileResult, stripped.logoId);
      return;
    }

    if (action === 'select' && state?.type === 'select') {
      pending.delete(chatId);
      const selectedIds = intent.selectedIds?.length > 1 ? intent.selectedIds : null;
      if (selectedIds) {
        const zip = new JSZip();
        for (const logoId of selectedIds) {
          const fileResult = await processLogo({ ...state.intent, logoId });
          if (fileResult) zip.file(`${logoId}.${fileResult.ext}`, fileResult.buffer);
        }
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        await sendZipToFeishu(chatId, zipBuffer, 'logos.zip');
      } else {
        const fileResult = await processLogo({ ...state.intent, logoId: intent.selectedId });
        if (!fileResult) throw new Error('logo 文件不存在');
        await sendLogoToFeishu(chatId, fileResult, intent.selectedId);
      }
      return;
    }

    // action === 'request'
    if (reply) {
      const hasCandidates = intent.candidates?.length > 1;
      if (hasCandidates || intent.logoId) {
        const type = hasCandidates ? 'select' : 'confirm';
        pending.set(chatId, { type, intent, candidates: intent.candidates ?? [] });
      } else {
        pending.delete(chatId);
      }
      await replyText(chatId, reply);
      return;
    }

    // 本地找到，直接处理
    if (intent.logoId) {
      pending.delete(chatId);
      const fileResult = await processLogo(intent);
      if (!fileResult) throw new Error('logo 文件不存在');
      await sendLogoToFeishu(chatId, fileResult, intent.logoId);
      return;
    }

    // 本地未找到 → 触发在线搜索
    await searchOnlineAndReply(chatId, userText, intent);

  } catch (err) {
    console.error(err);
    await replyText(chatId, '出了点问题，稍后再试试吧~');
  }
});

app.get('/', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
console.log('准备监听端口:', PORT);
app.listen(PORT, '0.0.0.0', () => console.log(`Logo Bot 启动，端口 ${PORT}`));
