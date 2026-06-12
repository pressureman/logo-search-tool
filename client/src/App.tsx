import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ExportedMessageRepositoryItem,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";

// ── 本地持久化（localStorage） ────────────────────────────────────────────────

const STORAGE_KEY = "logo-chat-history-v1";

function loadRepo(): ExportedMessageRepository {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ExportedMessageRepository) : { headId: null, messages: [] };
  } catch {
    return { headId: null, messages: [] };
  }
}

function createHistoryAdapter(): ThreadHistoryAdapter {
  return {
    async load() {
      return loadRepo();
    },
    async append(item: ExportedMessageRepositoryItem) {
      try {
        const repo = loadRepo();
        const deduped = repo.messages.filter((m) => m.message.id !== item.message.id);
        const updated: ExportedMessageRepository = {
          headId: item.message.id,
          messages: [...deduped, { message: item.message, parentId: item.parentId }],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // ignore storage errors
      }
    },
  };
}

// ── API 类型 ──────────────────────────────────────────────────────────────────

type ApiItem =
  | { type: "text"; data: string }
  | { type: "image"; data: string; ext?: string };

// ── ChatModelAdapter ──────────────────────────────────────────────────────────

const logoBotAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    // 取最后一条用户消息的文本
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText =
      lastUser?.content.find((c) => c.type === "text")?.text ?? "";

    const resp = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userText }),
      signal: abortSignal,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const items: ApiItem[] = await resp.json();

    type Part = NonNullable<ChatModelRunResult["content"]>[number];
    const parts: Part[] = items.flatMap((item): Part[] => {
      if (item.type === "text") {
        return [{ type: "text" as const, text: item.data }];
      }
      if (item.type === "image") {
        const mime =
          item.ext === "svg"
            ? "image/svg+xml"
            : `image/${item.ext ?? "png"}`;
        return [{ type: "image" as const, image: `data:${mime};base64,${item.data}` }];
      }
      return [];
    });

    yield { content: parts.length ? parts : [{ type: "text", text: "（没有内容）" }] };
  },
};

// ── Runtime Provider ──────────────────────────────────────────────────────────

function LogoBotRuntimeProvider({ children }: { children: React.ReactNode }) {
  const runtime = useLocalRuntime(logoBotAdapter, {
    adapters: { history: createHistoryAdapter() },
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
      <div className="h-dvh">
        <Thread />
      </div>
    </LogoBotRuntimeProvider>
  );
}
