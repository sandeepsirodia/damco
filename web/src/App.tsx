import { useState } from 'react';
import {
  CopilotKit,
  useCopilotAction,
  useCopilotAdditionalInstructions,
  useCopilotReadable,
} from '@copilotkit/react-core';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ChatView } from '@/components/ChatView';
import { FolderPicker } from '@/components/FolderPicker';
import { startSession, submitAnswers, pushToGithub } from '@/lib/api';
import { INSTRUCTIONS, TOOLS } from '@/lib/chatAgent';

interface QuestionForAgent {
  questionId: string;
  axis: string;
  question: string;
  groundedFile: string | null;
}

function CopilotActions({ setStatus, repoPath }: { setStatus: (status: string | null) => void; repoPath: string }) {
  useCopilotAdditionalInstructions({ instructions: INSTRUCTIONS });
  useCopilotReadable({ description: 'Selected repo path (from the Browse control in the header, may be empty)', value: repoPath });

  useCopilotAction({
    name: 'startFeatureSpec',
    ...TOOLS.startFeatureSpec,
    handler: async (args) => {
      const { description, repoPath, githubPat } = args as { description: string; repoPath: string; githubPat?: string };
      setStatus('Reading repo…');
      try {
        const data = await startSession({ description, repoPath, githubPat });
        const questions: QuestionForAgent[] = data.questions.map((q) => ({
          questionId: q.id,
          axis: q.axis,
          question: q.question,
          groundedFile: q.groundedFile,
        }));
        return {
          sessionId: data.sessionId,
          repoScan: data.repo.scanPills.map((p) => p.label).join(', '),
          questions,
        };
      } catch (err) {
        return { error: true, message: (err as Error).message };
      } finally {
        setStatus(null);
      }
    },
  });

  useCopilotAction({
    name: 'submitFeatureAnswers',
    ...TOOLS.submitFeatureAnswers,
    handler: async (args) => {
      const { sessionId, answers } = args as { sessionId: string; answers: unknown };
      setStatus('Drafting spec…');
      try {
        const payload = (answers as { questionId: string; answer?: string; flagged?: string }[]).map((a) => ({
          questionId: a.questionId,
          answer: a.answer?.trim() ? a.answer.trim() : null,
          flagged: a.flagged === 'skip' || a.flagged === 'vague' ? (a.flagged as 'skip' | 'vague') : null,
        }));
        return await submitAnswers(sessionId, payload);
      } catch (err) {
        return { error: true, message: (err as Error).message };
      } finally {
        setStatus(null);
      }
    },
    // No `render` here -- ChatView renders ResultsCard itself by reading
    // this tool's result straight out of the headless message list.
  });

  useCopilotAction({
    name: 'pushToGithub',
    ...TOOLS.pushToGithub,
    handler: async (args) => {
      const { sessionId, githubPat } = args as { sessionId: string; githubPat: string };
      setStatus('Pushing to GitHub…');
      try {
        const data = await pushToGithub(sessionId, githubPat);
        return {
          issueCount: data.issues.length,
          issues: data.issues.map((i) => `#${i.number} ${i.title} (${i.url})`),
          failedCount: data.errors.length,
          failures: data.errors.map((e) => `${e.title}: ${e.message}`),
        };
      } catch (err) {
        return { error: true, message: (err as Error).message };
      } finally {
        setStatus(null);
      }
    },
  });

  return null;
}

export default function App() {
  const [status, setStatus] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState('');

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" enableInspector={false}>
      <CopilotActions setStatus={setStatus} repoPath={repoPath} />
      <div className="h-screen flex flex-col">
        <header className="border-b bg-card px-4 py-3 flex items-center gap-2.5">
          <Avatar size="sm">
            <AvatarFallback className="bg-primary text-primary-foreground font-semibold">S</AvatarFallback>
          </Avatar>
          <h1 className="font-bold text-2xl text-foreground">Spec Clarity</h1>
          <span className="text-xs text-muted-foreground ml-1">repo-grounded feature specs, in chat</span>
          <div className="ml-auto flex items-center gap-2.5">
            <FolderPicker value={repoPath} onChange={setRepoPath} />
            <Badge
              variant={status ? 'default' : 'success'}
              className={`gap-1.5 ${status ? '' : 'bg-success text-success-foreground'}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status ? 'bg-primary-foreground animate-pulse' : 'bg-success-foreground'}`} />
              {status ?? 'Ready'}
            </Badge>
          </div>
        </header>
        <main className="flex-1 min-h-0">
          <ChatView repoPath={repoPath} />
        </main>
      </div>
    </CopilotKit>
  );
}
