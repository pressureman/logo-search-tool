import { useState, type FC } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type SuggestionAdapter,
} from "@assistant-ui/react";
import { createLocalStorageAdapter } from "@assistant-ui/core/react";
import { MenuIcon } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

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
  | { type: "image"; data: string; ext?: string; name?: string }
  | { type: "file"; data: string; ext?: string; name?: string; mimeType?: string };

// ── ChatModelAdapter ──────────────────────────────────────────────────────────

const logoBotAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content.find((c) => c.type === "text")?.text ?? "";

    // use first user message id as stable per-thread session key
    const firstUser = messages.find((m) => m.role === "user");
    const sessionId = firstUser?.id ?? crypto.randomUUID();

    // Build history from prior messages (exclude current user turn).
    // For assistant messages that are pure image/file (no text), inject "[已发送logo]"
    // so the LLM knows the previous request was fulfilled and "谷歌" after "微信" is a new request.
    const history = messages
      .slice(0, -1)
      .slice(-6)
      .map((m) => {
        const textContent = m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { type: "text"; text: string }).text)
          .join("");
        const hasMedia =
          m.role === "assistant" &&
          m.content.some((c) => c.type === "image" || c.type === "file");
        const content = textContent || (hasMedia ? "[已发送logo]" : "");
        return { role: m.role as "user" | "assistant", content };
      })
      .filter((m) => m.content.length > 0);

    let resp: Response;
    try {
      resp = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, sessionId, history }),
        signal: abortSignal,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      throw new Error(`网络连接失败，请检查网络后重试\n\n错误详情：${raw}`);
    }

    if (!resp.ok) {
      let friendly = "服务器开小差了，请稍后重试";
      let detail = `HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        if (body?.error) friendly = body.error;
        if (body?.detail) detail += ` ${body.detail}`;
      } catch {
        // 响应体非 JSON，保留 HTTP 状态码即可
      }
      throw new Error(`${friendly}\n\n错误详情：${detail}`);
    }

    let items: ApiItem[];
    try {
      items = await resp.json();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      throw new Error(`返回内容解析失败，请稍后重试\n\n错误详情：${raw}`);
    }
    type Part = NonNullable<ChatModelRunResult["content"]>[number];
    const parts: Part[] = items.flatMap((item): Part[] => {
      if (item.type === "text") return [{ type: "text" as const, text: item.data }];
      if (item.type === "image") {
        const mime = item.ext === "svg" ? "image/svg+xml" : `image/${item.ext ?? "png"}`;
        return [{ type: "image" as const, image: `data:${mime};base64,${item.data}`, filename: item.name }];
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

// ── 侧边栏内容（桌面侧栏 / 移动抽屉共用） ──────────────────────────────────────

// onNavigate：点击「新对话」或某个线程后回调（移动端用来收起抽屉）
const SidebarNav: FC<{ onNavigate?: () => void }> = ({ onNavigate }) => (
  <div
    className="flex min-h-0 flex-1 flex-col"
    onClickCapture={(e) => {
      // 捕获阶段处理，避免 assistant-ui 在线程入口 stopPropagation 后收不到事件。
      // 只有点到「新建对话」或线程入口才收起抽屉，重命名/删除等操作保持打开。
      if (!onNavigate) return;
      const el = e.target as HTMLElement;
      if (el.closest(".aui-thread-list-new, .aui-thread-list-item-trigger")) {
        onNavigate();
      }
    }}
  >
    <div className="mb-3 flex items-center gap-2 px-2.5">
      <img src="/favicon.svg" alt="Logoman" className="size-6 object-contain" />
      <span className="text-sm font-semibold">Logoman</span>
    </div>
    <ThreadList />
  </div>
);

// ── 移动端顶栏 + 抽屉 ──────────────────────────────────────────────────────────

const MobileTopBar: FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-9" aria-label="打开菜单">
            <MenuIcon className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="px-2 py-3">
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex items-center gap-2">
        <img src="/favicon.svg" alt="Logoman" className="size-6 object-contain" />
        <span className="text-sm font-semibold">Logoman</span>
      </div>
    </header>
  );
};

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <LogoBotRuntimeProvider>
      {/* 两栏布局：左侧边栏 + 右侧对话区 */}
      <div className="bg-background flex h-dvh overflow-hidden">
        {/* 桌面侧边栏（移动端隐藏） */}
        <aside className="bg-sidebar text-sidebar-foreground hidden w-56 shrink-0 flex-col border-r border-sidebar-border px-2 py-3 md:flex">
          <SidebarNav />
        </aside>

        {/* 主内容区 */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <MobileTopBar />
          <Thread components={{ Welcome: LogoBotWelcome }} />
        </main>
      </div>
    </LogoBotRuntimeProvider>
  );
}
