import { useEffect, useMemo, useRef, useState } from 'react';
import { useCopilotChatInternal as useCopilotChatHeadless } from '@copilotkit/react-core';
import ReactMarkdown from 'react-markdown';
import { ArrowUp, Check, Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { ResultsCard } from '@/components/ResultsCard';
import type { AnswersResponse } from '@/lib/api';

// Friendly, presentable labels for the tool-call chips below -- shown while
// a tool is running (no toolResults entry yet) and, for tools with no
// dedicated result card, once it resolves.
const TOOL_CALL_LABELS: Record<string, string> = {
  startFeatureSpec: 'Reading the repo',
  submitFeatureAnswers: 'Drafting the spec',
  pushToGithub: 'Pushing to GitHub',
};

// Only ever called with a real repoPath -- the caller renders a "select a
// repo" hint instead of these buttons when nothing's selected yet, rather
// than falling back to a hardcoded example repo.
function getStarterPrompts(repoPath: string) {
  return [
    { title: 'Rate limiter', message: `Spec a per-user rate limiter for ${repoPath}` },
    { title: 'Webhook verification', message: `Add webhook signature verification middleware to ${repoPath}` },
    { title: 'Audit this repo', message: `Spec a plugin system for extending routing behavior in ${repoPath}` },
  ];
}

const INITIAL_MESSAGE =
  "Tell me about the feature you want to build, and point me at the repo (a local path or GitHub URL) -- I'll read it, ask a few grounded questions right here in chat, and put together a PRD/TRD.";

function BotAvatar() {
  return (
    <Avatar size="sm" className="mt-0.5 shrink-0">
      <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">S</AvatarFallback>
    </Avatar>
  );
}

// The actual chat UI, built from shadcn primitives on top of CopilotKit's
// headless data hook (messages/sendMessage/isLoading only -- no packaged
// <CopilotChat> component, so no CopilotKit-owned DOM or CSS to re-skin).
// The header's status Badge (see App.tsx) already covers system-status
// visibility, so this view has no separate status line of its own.
export function ChatView({ repoPath }: { repoPath: string }) {
  const { messages, sendMessage, isLoading } = useCopilotChatHeadless();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const starterPrompts = useMemo(() => getStarterPrompts(repoPath), [repoPath]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isLoading]);

  const toolResults = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.role === 'tool') map.set(m.toolCallId, m.content);
    }
    return map;
  }, [messages]);

  function handleSend(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || isLoading) return;
    sendMessage({ id: crypto.randomUUID(), role: 'user', content });
    setDraft('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && (
            <div className="flex gap-3">
              <BotAvatar />
              <p className="pt-1 text-sm text-foreground">{INITIAL_MESSAGE}</p>
            </div>
          )}

          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                    {typeof m.content === 'string' ? m.content : ''}
                  </div>
                </div>
              );
            }

            if (m.role === 'assistant') {
              const cards = (m.toolCalls ?? [])
                .filter((tc) => tc.function.name === 'submitFeatureAnswers')
                .map((tc) => {
                  const raw = toolResults.get(tc.id);
                  if (!raw) return null;
                  try {
                    const parsed = JSON.parse(raw) as AnswersResponse & { error?: boolean };
                    if (parsed.error) return null;
                    return <ResultsCard key={tc.id} data={parsed} />;
                  } catch {
                    return null;
                  }
                });

              // A visible chip per tool call: spinner while it's running (this
              // is the "it takes time and shows nothing" gap), then a small
              // done/failed chip -- except submitFeatureAnswers on success,
              // where the ResultsCard above already represents completion.
              const toolChips = (m.toolCalls ?? [])
                .map((tc) => {
                  const name = tc.function.name;
                  const label = TOOL_CALL_LABELS[name] ?? name;
                  const raw = toolResults.get(tc.id);
                  if (!raw) {
                    return (
                      <Badge key={tc.id} variant="outline" className="gap-1.5">
                        <Loader2 className="size-3 animate-spin" />
                        {label}…
                      </Badge>
                    );
                  }
                  let errored = false;
                  try {
                    errored = !!(JSON.parse(raw) as { error?: boolean }).error;
                  } catch {
                    // not JSON -- treat as a normal success payload
                  }
                  if (name === 'submitFeatureAnswers' && !errored) return null;
                  return (
                    <Badge key={tc.id} variant={errored ? 'destructive' : 'success'} className="gap-1.5">
                      {!errored && <Check className="size-3" />}
                      {errored ? `${label} failed` : label}
                    </Badge>
                  );
                })
                .filter(Boolean);

              if (!m.content && cards.every((c) => c === null) && toolChips.length === 0) return null;

              return (
                <div key={m.id} className="flex gap-3">
                  <BotAvatar />
                  <div className="min-w-0 flex-1 space-y-3">
                    {toolChips.length > 0 && <div className="flex flex-wrap gap-1.5">{toolChips}</div>}
                    {m.content && (
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    )}
                    {cards}
                  </div>
                </div>
              );
            }

            return null;
          })}

          {isLoading && (
            <div className="flex gap-3">
              <BotAvatar />
              <div className="flex items-center gap-1 pt-3 text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="border-t bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {messages.length === 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {repoPath.trim() ? (
                starterPrompts.map((p) => (
                  <Button
                    key={p.title}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full text-primary"
                    onClick={() => handleSend(p.message)}
                  >
                    {p.title}
                  </Button>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  Select a repo above, or paste a GitHub URL in your message, to try a quick suggestion.
                </p>
              )}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe a feature, and a repo path or GitHub URL..."
              rows={1}
              className="max-h-36 resize-none rounded-2xl"
            />
            <Button
              type="button"
              size="icon"
              className="rounded-full"
              onClick={() => handleSend()}
              disabled={!draft.trim() || isLoading}
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
