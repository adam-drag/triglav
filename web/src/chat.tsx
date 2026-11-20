// The chat pane shared by the Operator page and the Architect pane of an initiative room: the stream of one chat, its
// messages and Confirm cards, and the composer. The server decides who speaks; this file only shows it.
import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import { get, post, type Json } from './api.ts';
import { checkImageBase64, MAX_IMAGE_BYTES, MAX_IMAGES, sniffImageType, type ImageType } from '../../src/image-types.ts';

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

/** `images` are the ids of a Client message's images (Architect chats); each is drawn from the chat's image route. */
export type ChatMsg = { id: number; role: string; text: string; images?: string[] };
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
          {/* A Confirm that the board refused leaves the card pending with the reason, so the Client sees why nothing was posted. */}
          {a.result && <p className="error">{a.result}</p>}
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
    // Counts the state events of the stream. A load that started before one does not overwrite that newer state.
    let stateEvents = 0;
    const load = () => {
      const before = stateEvents;
      return get<Json>(`${base}/${chatId}`).then((c) => {
        if (!alive) return;
        // Messages that streamed in meanwhile are already there: keep one of each.
        setMessages((have) => [...new Map([...have, ...c.messages].map((m: ChatMsg) => [m.id, m])).values()].sort((a, b) => a.id - b.id));
        setActions((have) => ({ ...have, ...Object.fromEntries(c.actions.map((x: ChatActionRow) => [x.id, x])) }));
        if (stateEvents === before) setState(c.state);
      });
    };
    // The stream is open only while the tab is visible: a hidden tab holds no connection. The hello of each stream
    // loads the chat again, so a reopened stream catches up on what it missed.
    let source: EventSource | null = null;
    const open = () => {
      source = new EventSource(`${base}/${chatId}/stream`);
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
          stateEvents++;
          setState(e.state);
          if (e.state !== 'working') setPartial('');
        }
      };
    };
    const onVisibility = () => {
      if (!alive) return;
      if (document.visibilityState === 'hidden') {
        source?.close();
        source = null;
      } else if (!source) {
        open();
      }
    };
    if (document.visibilityState === 'hidden') void load();
    else open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      source?.close();
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
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, partial]);
  // A name in code or bold that is a design block shown on the page (a job card, a wave) becomes a link to that block.
  // A block in a hidden pane (the Design pane on a narrow screen while the chat is shown) is not a target.
  const target = (name: string | undefined) => {
    const block = name ? document.getElementById(`block-${name}`) : null;
    return block?.getClientRects().length ? block : null;
  };
  useEffect(() => {
    for (const el of log.current?.querySelectorAll<HTMLElement>('.operator-says code, .operator-says strong') ?? []) {
      const linked = !!target(el.textContent?.trim());
      el.classList.toggle('block-link', linked);
      if (linked) {
        el.setAttribute('role', 'link');
        el.tabIndex = 0;
      } else {
        el.removeAttribute('role');
        el.removeAttribute('tabindex');
      }
    }
  });
  const jump = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
    const block = target((e.target as HTMLElement).closest('.block-link')?.textContent?.trim());
    if (!block) return;
    e.preventDefault();
    block.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    block.classList.remove('flash');
    void block.offsetWidth;
    block.classList.add('flash');
  };
  return (
    <div className="chat-log" data-testid="chat-log" ref={log} onClick={jump} onKeyDown={jump}>
      {!messages.length && empty}
      {messages.map((m) =>
        m.role === 'operator' ? (
          <div key={m.id} className="chat-msg operator-says" data-testid="chat-operator" dangerouslySetInnerHTML={{ __html: markdown.parse(m.text, { async: false }) }} />
        ) : m.role === 'action' ? (
          <ActionCard key={m.id} a={actions[m.text]} chatId={chatId!} base={chat.base} who={who} onDecided={onDecided} />
        ) : m.role === 'client' ? (
          <div key={m.id} className="chat-msg client-says" data-testid="chat-client">
            {m.text}
            {!!m.images?.length && (
              <div className="chat-images">
                {m.images.map((id) => (
                  <img key={id} src={`${chat.base}/${chatId}/images/${id}`} alt="Image sent with this message" loading="lazy" className="chat-image" data-testid="chat-image" />
                ))}
              </div>
            )}
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

/** A picture ready to send: its type read from its bytes, and its base64 (the server checks it again). */
type Picture = { media_type: ImageType; data: string };
/** The long edge of a picture after the browser shrinks it: longer pictures are scaled down before they are sent. */
const MAX_EDGE = 2000;

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Scales a picture whose long edge is over MAX_EDGE. A jpeg stays a jpeg; the other types are sent as png. */
async function shrink(file: Blob, type: ImageType): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= MAX_EDGE) {
    bitmap.close();
    return file;
  }
  const scale = MAX_EDGE / long;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((done) => canvas.toBlob(done, type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92));
}

/**
 * Checks one file the way the server does: its first bytes give the type (the name and the browser's type do not count), its
 * size is checked before and after the shrink, and the result is the base64 the message carries. A refusal says why.
 */
async function pictureOf(file: Blob): Promise<Picture | { refused: string }> {
  const type = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!type) return { refused: 'That file is not a png, jpeg, webp or gif image.' };
  if (file.size > MAX_IMAGE_BYTES) return { refused: 'That image is over 5 MB. Use a smaller screenshot.' };
  let blob: Blob | null;
  try {
    blob = await shrink(file, type);
  } catch {
    // The browser cannot decode a file whose first bytes look like a picture (corrupt, or cut short).
    return { refused: 'That image could not be read.' };
  }
  if (!blob) return { refused: 'That image could not be resized. Try a smaller one.' };
  const data = await toBase64(blob);
  const checked = checkImageBase64(data);
  if (!checked.ok) return { refused: checked.reason };
  return { media_type: checked.type, data };
}

/**
 * The box after a send: the text that was sent (`sent`, as it was read, untrimmed) leaves it only when it is still whole at the
 * start or the end, and a space or the box edge stands on its other side. Otherwise the box is kept whole, so text typed next
 * to the sent words is never cut.
 */
function leftAfterSend(now: string, sent: string): string {
  if (!sent) return now;
  if (now.startsWith(sent)) {
    const rest = now.slice(sent.length);
    if (rest === '' || /^\s/.test(rest) || /\s$/.test(sent)) return rest.trimStart();
  }
  if (now.endsWith(sent)) {
    const head = now.slice(0, now.length - sent.length);
    if (head === '' || /\s$/.test(head) || /^\s/.test(sent)) return head.trimEnd();
  }
  return now;
}

/**
 * The message box. `send` posts the text and the pictures (base64, Architect chats only); the box empties only when that worked.
 * `images` turns on paste and drop of pictures. The Operator's box takes none: a dropped file is refused, not opened.
 */
export function ChatComposer({
  chatId,
  base = OPERATOR_CHATS,
  working,
  placeholder,
  send,
  text: shared,
  images = false,
}: {
  chatId: string | undefined;
  base?: ChatBase;
  working: boolean;
  placeholder: string;
  send: (text: string, images: { data: string }[]) => Promise<unknown>;
  text?: [string, (t: string) => void];
  images?: boolean;
}) {
  const own = useState('');
  const [text, setText] = shared ?? own;
  const [pictures, setPictures] = useState<Picture[]>([]);
  // The count the next file is checked against: a second paste before the first has finished must still see the first.
  const latest = useRef<Picture[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Counts every refusal that is set: a send clears the refusal on success only when none was set while it ran.
  const refusals = useRef(0);
  const refuse = (message: string) => {
    refusals.current += 1;
    setRefusal(message);
  };
  const act = useAction();
  const store = (next: Picture[]) => {
    latest.current = next;
    setPictures(next);
  };
  const addNow = async (files: File[]) => {
    if (!images) {
      refuse('The Operator takes text only. Images go to an initiative\'s Architect.');
      return;
    }
    setRefusal(null);
    const added: Picture[] = [];
    for (const file of files) {
      if (latest.current.length + added.length >= MAX_IMAGES) {
        refuse(`A message can carry at most ${MAX_IMAGES} images. Remove one first.`);
        break;
      }
      const got = await pictureOf(file);
      if ('refused' in got) refuse(got.refused);
      else added.push(got);
    }
    if (added.length) store([...latest.current, ...added]);
  };
  // One paste or drop at a time: each one counts the pictures the earlier ones stored, so two that overlap cannot pass the limit.
  const queued = useRef<Promise<void>>(Promise.resolve());
  // True from the first line of submit until its send has finished: the guard against a second submit.
  const sending = useRef(false);
  // The box as it is now: a send reads it after its wait, not at the click.
  const typedNow = useRef(text);
  useEffect(() => {
    typedNow.current = text;
  }, [text]);
  const add = (files: File[]) => {
    queued.current = queued.current.then(() => addNow(files)).catch(() => refuse('That image could not be read.'));
    return queued.current;
  };
  const submit = async () => {
    // A second submit while this one waits or sends would post the same message again, so it is ignored.
    if (sending.current) return;
    sending.current = true;
    try {
      const refusalsSeen = refusals.current;
      // A paste or drop still being decoded belongs to this message: wait for it, and for the text typed meanwhile, before they are read.
      await queued.current;
      const raw = typedNow.current;
      const t = raw.trim();
      const sent = latest.current;
      if (!t && sent.length === 0) return;
      if (await act.run(() => send(t, sent.map(({ data }) => ({ data }))))) {
        // The words that were sent leave the box; words typed after they were read stay for the next message.
        const now = typedNow.current;
        setText(leftAfterSend(now, raw));
        // Only the pictures that were sent leave the box: one added while the send was in flight stays.
        store(latest.current.filter((p) => !sent.includes(p)));
        // A refusal set while the send ran (a file pasted meanwhile) stays on screen: it says why a file was left out.
        if (refusals.current === refusalsSeen) setRefusal(null);
      }
    } finally {
      sending.current = false;
    }
  };
  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void add([...e.dataTransfer.files]);
      }}
    >
      {pictures.length > 0 && (
        <ul className="chat-thumbs" aria-label="Images to send" data-testid="chat-thumbs">
          {pictures.map((p, n) => (
            <li key={n} className="chat-thumb">
              <img src={`data:${p.media_type};base64,${p.data}`} alt={`Image ${n + 1} to send`} />
              <button type="button" aria-label={`Remove image ${n + 1}`} onClick={() => store(latest.current.filter((_, i) => i !== n))}>
                x
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="Message"
        placeholder={placeholder}
        value={text}
        rows={2}
        onPaste={(e) => {
          if (!e.clipboardData.files.length) return;
          const hasText = e.clipboardData.getData('text/plain') !== '';
          // A paste with text (a spreadsheet, a document) keeps the text. The Operator's box takes no picture, so it stops here.
          if (hasText && !images) return;
          if (!hasText) e.preventDefault();
          void add([...e.clipboardData.files]);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {images && <p className="muted composer-note">Images are not scanned for secrets. A screenshot can show a token or a key, and the Architect reads it.</p>}
      {refusal && (
        <p className="error composer-note" role="alert" data-testid="chat-refusal">
          {refusal}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={act.busy || (!text.trim() && pictures.length === 0)} data-testid="chat-send">
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
