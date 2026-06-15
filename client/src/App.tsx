import { type FC } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type SuggestionAdapter,
} from "@assistant-ui/react";
import { createLocalStorageAdapter } from "@assistant-ui/core/react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";

// ── 本地持久化（localStorage） ────────────────────────────────────────────────
// 每个 thread = 一个 session。线程列表元数据、各线程消息均由
// createLocalStorageAdapter 写入 localStorage；删除线程会一并清掉其消息。

const STORAGE_PREFIX = "logobot:";

// createLocalStorageAdapter 需要异步存储接口，这里包一层浏览器同步 localStorage
const browserStorage = {
  async getItem(key: string) {
    return localStorage.getItem(key);
  },
  async setItem(key: string, value: string) {
    localStorage.setItem(key, value);
  },
  async removeItem(key: string) {
    localStorage.removeItem(key);
  },
};

// 线程标题取第一条用户消息文本
const titleGenerator = {
  async generateTitle(messages: readonly { role: string; content: readonly unknown[] }[]) {
    const firstUser = messages.find((m) => m.role === "user");
    const text = (firstUser?.content as { type: string; text?: string }[] | undefined)
      ?.find((c) => c.type === "text")?.text;
    return text?.trim().slice(0, 40) || "新对话";
  },
};

// ── API 类型 ──────────────────────────────────────────────────────────────────

type ApiItem =
  | { type: "text"; data: string }
  | { type: "image"; data: string; ext?: string }
  | { type: "file"; data: string; ext?: string; name?: string; mimeType?: string };

// ── ChatModelAdapter ──────────────────────────────────────────────────────────

const logoBotAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content.find((c) => c.type === "text")?.text ?? "";

    // use first user message id as stable per-thread session key
    const firstUser = messages.find((m) => m.role === "user");
    const sessionId = firstUser?.id ?? crypto.randomUUID();

    // Build text-only history from prior messages (exclude current user turn)
    const history = messages
      .slice(0, -1)
      .slice(-6)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { type: "text"; text: string }).text)
          .join(""),
      }))
      .filter((m) => m.content.length > 0);

    const resp = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userText, sessionId, history }),
      signal: abortSignal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const items: ApiItem[] = await resp.json();
    type Part = NonNullable<ChatModelRunResult["content"]>[number];
    const parts: Part[] = items.flatMap((item): Part[] => {
      if (item.type === "text") return [{ type: "text" as const, text: item.data }];
      if (item.type === "image") {
        const mime = item.ext === "svg" ? "image/svg+xml" : `image/${item.ext ?? "png"}`;
        return [{ type: "image" as const, image: `data:${mime};base64,${item.data}` }];
      }
      if (item.type === "file") {
        const mime = item.mimeType ?? "application/octet-stream";
        return [
          {
            type: "file" as const,
            data: `data:${mime};base64,${item.data}`,
            mimeType: mime,
            filename: item.name ?? "download",
          },
        ];
      }
      return [];
    });
    yield { content: parts.length ? parts : [{ type: "text", text: "（没有内容）" }] };
  },
};

// ── 固定建议词 ────────────────────────────────────────────────────────────────

const suggestionAdapter: SuggestionAdapter = {
  async generate() {
    return [
      { prompt: "给我 3Chat logo，PNG 格式" },
      { prompt: "微信 logo，蓝色，512px" },
      { prompt: "Apple logo，黑色，SVG" },
      { prompt: "GitHub logo，白色背景" },
    ];
  },
};

// ── 自定义欢迎区域 ─────────────────────────────────────────────────────────────

const LogoBotWelcome: FC = () => (
  <div className="mb-6 flex flex-col items-center px-4 text-center">
    <img src="/favicon.svg" alt="Logoman" className="mb-3 h-12 w-12 shrink-0 max-w-none object-contain" />
    <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
      Logoman
    </h1>
    <p className="text-muted-foreground mt-2 text-sm">
      告诉我你需要哪个 logo，格式、颜色、尺寸都能搞
    </p>
  </div>
);

// ── Runtime Provider ──────────────────────────────────────────────────────────

function LogoBotRuntimeProvider({ children }: { children: React.ReactNode }) {
  const runtime = useRemoteThreadListRuntime({
    // 每个线程一个本地 runtime；history 由下方 adapter 的 Provider 按线程注入
    runtimeHook: () =>
      useLocalRuntime(logoBotAdapter, {
        adapters: { suggestion: suggestionAdapter },
      }),
    adapter: createLocalStorageAdapter({
      storage: browserStorage,
      prefix: STORAGE_PREFIX,
      titleGenerator,
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <LogoBotRuntimeProvider>
      {/* 两栏布局：左侧边栏 + 右侧对话区 */}
      <div className="bg-background flex h-dvh overflow-hidden">
        {/* 侧边栏 */}
        <aside className="bg-sidebar text-sidebar-foreground flex w-56 shrink-0 flex-col border-r border-sidebar-border px-2 py-3">
          {/* Logo */}
          <div className="mb-3 flex items-center gap-2 px-2.5">
            <img src="/favicon.svg" alt="Logoman" className="size-6 object-contain" />
            <span className="text-sm font-semibold">Logoman</span>
          </div>
          {/* 线程列表 */}
          <ThreadList />
        </aside>

        {/* 主内容区 */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <Thread components={{ Welcome: LogoBotWelcome }} />
        </main>
      </div>
    </LogoBotRuntimeProvider>
  );
}
