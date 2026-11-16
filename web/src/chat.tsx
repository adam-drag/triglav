// The chat pane shared by the Operator page and the Architect pane of an initiative room: the stream of one chat, its
// messages and Confirm cards, and the composer. The server decides who speaks; this file only shows it.
import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import { get, post, type Json } from './api.ts';

export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Raw HTML is shown as text, so a stray <placeholder> stays visible and nothing can inject markup. Only http(s) and in-app links
// stay links, and images are not loaded: the Operator's and the Architect's replies are model output and can repeat text from a ticket or a log.
export const markdown = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link: ({ href, text }) => (/^(https?:\/\/|#\/)/.test(href) ? `<a href="${escapeHtml(href)}"${href.startsWith('#') ? '' : ' target="_blank" rel="noreferrer"'}>${escapeHtml(text)}</a>` : escapeHtml(text)),
    image: ({ text }) => escapeHtml(text),
  },
});

export type ChatMsg = { id: number; role: string; text: string };
export type ChatActionRow = { id: string; kind: string; summary: string; reason: string | null; state: string; result: string | null };

const ACTION_OUTCOME: Record<string, string> = { denied: 'Denied.', expired: 'Too old to confirm.', running: 'Confirmed. Waiting for the host runner...' };

/** A change the agent asks for. The text is written by Triglav from its own data; nothing happens until the Client confirms. */
export function ActionCard({ a, chatId, base = OPERATOR_CHATS, who, onDecided }: { a: ChatActionRow | undefined; chatId: string; base?: ChatBase; who: string; onDecided?: () => void }) {
  const act = useAction();
  if (!a) return null;
  const decide = (decision: 'confirm' | 'deny') => act.run(() => post(`${base}/${chatId}/actions/${a.id}`, { decision })).then((ok) => ok && onDecided?.());
  return (
    <div className={`chat-action action-${a.state}`} data-testid="chat-action" data-state={a.state} data-kind={a.kind}>
      <div className="chat-action-head">{a.state === 'pending' ? `${who} asks to` : `${who} asked to`}</div>
      <p className="chat-action-summary">{a.summary}</p>
      {a.reason && <p className="muted">Its reason: {a.reason}</p>}
      {a.state === 'pending' ? (
        <div className="actions">
          <button className="primary" disabled={act.busy} data-testid="action-confirm" onClick={() => void decide('confirm')}>
            Confirm
          </button>
          <button disabled={act.busy} data-testid="action-deny" onClick={() => void decide('deny')}>
            Deny
          </button>
          {act.error && <span className="error">{act.error}</span>}
        </div>
      ) : (
        <p className={a.state === 'failed' ? 'error' : 'muted'}>{a.state === 'done' ? `Done. ${a.result ?? ''}` : a.state === 'failed' ? `Failed. ${a.result ?? ''}` : ACTION_OUTCOME[a.state]}</p>
      )}
    </div>
  );
}

/** The Client routes of a chat, one prefix per kind; the server refuses a chat of the other kind on each. */
export const OPERATOR_CHATS = '/api/chats';
export const ARCHITECT_CHATS = '/api/architect-chats';
type ChatBase = typeof OPERATOR_CHATS | typeof ARCHITECT_CHATS;

/** One chat, live: its messages, the reply streaming in, its Confirm cards and its state. */
export function useChat(chatId: string | undefined, base: ChatBase = OPERATOR_CHATS) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [partial, setPartial] = useState('');
  const [state, setState] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, ChatActionRow>>({});
  useEffect(() => {
    setMessages([]);
    setPartial('');
    setState(null);
    setActions({});
    if (!chatId) return;
    let alive = true;
    const load = () =>
      get<Json>(`${base}/${chatId}`).then((c) => {
        if (!alive) return;
        // Messages that streamed in meanwhile are already there: keep one of each.
        setMessages((have) => [...new Map([...have, ...c.messages].map((m: ChatMsg) => [m.id, m])).values()].sort((a, b) => a.id - b.id));
        setActions((have) => ({ ...have, ...Object.fromEntries(c.actions.map((x: ChatActionRow) => [x.id, x])) }));
        setState((s) => s ?? c.state);
      });
    const source = new EventSource(`${base}/${chatId}/stream`);
    source.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'hello') {
        setPartial(e.partial);
        void load();
      } else if (e.type === 'delta') setPartial((p) => p + e.text);
      else if (e.type === 'message') {
        setMessages((have) => (have.some((m) => m.id === e.message.id) ? have : [...have, e.message]));
        if (e.message.role === 'operator') setPartial('');
      } else if (e.type === 'action') setActions((have) => ({ ...have, [e.action.id]: e.action }));
      else if (e.type === 'state') {
        setState(e.state);
        if (e.state !== 'working') setPartial('');
      }
    };
    return () => {
      alive = false;
      source.close();
    };
  }, [chatId, base]);
  return { messages, partial, state, actions, base };
}

/**
 * The messages of a chat. `who` names the agent ("The Operator", "The Architect"); its replies are stored with the role
 * `operator` for both, and are always shown as the agent's, never as the Client's.
 */
export function ChatLog({ chatId, chat, who, empty, onDecided }: { chatId: string | undefined; chat: ReturnType<typeof useChat>; who: string; empty?: React.ReactNode; onDecided?: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const { messages, partial, state, actions } = chat;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, partial]);
  return (
    <div className="chat-log" data-testid="chat-log">
      {!messages.length && empty}
      {messages.map((m) =>
        m.role === 'operator' ? (
          <div key={m.id} className="chat-msg operator-says" data-testid="chat-operator" dangerouslySetInnerHTML={{ __html: markdown.parse(m.text, { async: false }) }} />
        ) : m.role === 'action' ? (
          <ActionCard key={m.id} a={actions[m.text]} chatId={chatId!} base={chat.base} who={who} onDecided={onDecided} />
        ) : m.role === 'client' ? (
          <div key={m.id} className="chat-msg client-says" data-testid="chat-client">
            {m.text}
          </div>
        ) : (
          <div key={m.id} className={`chat-note ${m.role}`} data-testid={`chat-${m.role}`}>
            {m.role === 'tool' ? `Looked at: ${m.text}` : m.text}
          </div>
        ),
      )}
      {partial && <div className="chat-msg operator-says streaming" data-testid="chat-partial" dangerouslySetInnerHTML={{ __html: markdown.parse(partial, { async: false }) }} />}
      {state === 'working' && !partial && <div className="chat-note muted">Working...</div>}
      <div ref={end} />
    </div>
  );
}

/** The message box. `send` posts the text; the box empties only when that worked. */
export function ChatComposer({ chatId, base = OPERATOR_CHATS, working, placeholder, send, text: shared }: { chatId: string | undefined; base?: ChatBase; working: boolean; placeholder: string; send: (text: string) => Promise<unknown>; text?: [string, (t: string) => void] }) {
  const own = useState('');
  const [text, setText] = shared ?? own;
  const act = useAction();
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await act.run(() => send(t))) setText('');
  };
  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label="Message"
        placeholder={placeholder}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="actions">
        <button className="primary" disabled={act.busy || !text.trim()} data-testid="chat-send">
          Send
        </button>
        {working && chatId && (
          <button type="button" className="danger" data-testid="chat-stop" onClick={() => void post(`${base}/${chatId}/stop`, {})}>
            Stop
          </button>
        )}
        {act.error && <span className="error">{act.error}</span>}
      </div>
    </form>
  );
}
