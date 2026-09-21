import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pushToGithub, type AnswersResponse } from '@/lib/api';

const CATEGORY_LABEL: Record<string, string> = {
  PRODUCT_DECISION: 'Product',
  ENGINEERING_DECISION: 'Engineering',
  ASSUMPTION_MADE: 'Assumption',
};

// Display-only -- this is "the output" of a conversation that otherwise
// happens entirely as chat messages. No form fields except the optional
// GitHub-push utility, which is a secondary action on an already-finished
// result, not a step the user has to complete to get an answer. Every
// grouping below is a nested shadcn Card (size="sm"), not a hand-styled div.
export function ResultsCard({ data }: { data: AnswersResponse }) {
  const [ghPat, setGhPat] = useState('');
  const [ghStatus, setGhStatus] = useState<'idle' | 'pushing' | 'done' | 'error'>('idle');
  const [ghIssues, setGhIssues] = useState<{ number: number; title: string; url: string }[]>([]);
  const [ghError, setGhError] = useState<string | null>(null);

  async function handlePush() {
    if (!ghPat.trim()) return;
    setGhStatus('pushing');
    setGhError(null);
    try {
      const res = await pushToGithub(data.sessionId, ghPat.trim());
      setGhIssues(res.issues);
      setGhStatus('done');
    } catch (err) {
      setGhError((err as Error).message);
      setGhStatus('error');
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile label="Estimate" value={`${data.estimate.low}-${data.estimate.high}d`} sub={`up to ${data.estimate.worst}d worst`} />
          <StatTile label="Blast radius" value={String(data.blastRadius.count)} sub={data.blastRadius.file ?? 'none identified'} />
          <StatTile label="Open questions" value={String(data.openQuestions.length)} sub="see tab" />
          <StatTile
            label="Coverage gate"
            value={data.coverageGate.passed ? 'Passed' : 'Failed'}
            sub={data.coverageGate.passed ? 'all findings reached docs' : `${data.coverageGate.missing.length} missing`}
            tone={data.coverageGate.passed ? 'success' : 'destructive'}
          />
        </div>

        <Tabs defaultValue="prd">
          <TabsList>
            <TabsTrigger value="prd">PRD</TabsTrigger>
            <TabsTrigger value="trd">TRD</TabsTrigger>
            <TabsTrigger value="oq">Open Questions ({data.openQuestions.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="prd" className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{data.prd}</ReactMarkdown>
          </TabsContent>
          <TabsContent value="trd" className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{data.trd}</ReactMarkdown>
          </TabsContent>
          <TabsContent value="oq" className="space-y-2">
            {data.openQuestions.map((q, i) => (
              <Card key={i} size="sm" className="flex-row gap-3">
                <CardContent className="flex gap-3 items-start w-full">
                  <Badge variant="outline" className="shrink-0">
                    {CATEGORY_LABEL[q.category] ?? q.category}
                  </Badge>
                  <div>
                    <p className="text-sm">{q.text}</p>
                    <CardDescription className="mt-1">{q.source ?? `confidence: ${q.confidence}`}</CardDescription>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>

        {data.grounded.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardDescription>Grounded in</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {data.grounded.map((f) => (
                <Badge key={f} variant="secondary" className="font-mono font-normal">
                  {f}
                </Badge>
              ))}
            </CardContent>
          </Card>
        )}

        <Card size="sm">
          <CardHeader>
            <CardDescription>Push open questions to GitHub Issues</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Input type="password" placeholder="GitHub PAT" value={ghPat} onChange={(e) => setGhPat(e.target.value)} />
              <Button size="sm" onClick={handlePush} disabled={!ghPat.trim() || ghStatus === 'pushing'}>
                {ghStatus === 'pushing' ? 'Pushing…' : 'Push'}
              </Button>
            </div>
            {ghStatus === 'error' && <p className="text-sm text-destructive">{ghError}</p>}
            {ghStatus === 'done' && (
              <ul className="text-sm text-muted-foreground space-y-1">
                {ghIssues.map((i) => (
                  <li key={i.number}>
                    <a href={i.url} target="_blank" rel="noreferrer" className="underline">
                      #{i.number}
                    </a>{' '}
                    — {i.title}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'success' | 'destructive' }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`font-mono text-lg ${tone === 'success' ? 'text-success' : tone === 'destructive' ? 'text-destructive' : ''}`}>
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription className="truncate">{sub}</CardDescription>
      </CardContent>
    </Card>
  );
}
