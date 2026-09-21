import { useEffect, useState } from 'react';
import { Folder, FolderOpen, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { listDir, type FsDir } from '@/lib/api';

export function FolderPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(value);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<FsDir[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function navigate(target?: string) {
    setError(null);
    try {
      const res = await listDir(target || value);
      setPath(res.path);
      setParent(res.parent);
      setDirs(res.dirs);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (open) navigate(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Repo path (local) or GitHub URL"
        className="h-8 w-72 text-xs"
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <FolderOpen className="size-3.5" />
            Browse
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Select a repo folder</DialogTitle>
          <div className="mt-3 flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!parent}
              onClick={() => navigate(parent!)}
              aria-label="Up one level"
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && navigate(path)}
              className="h-8 text-xs"
            />
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <ScrollArea className="mt-2 h-64 rounded-md border">
            <div className="p-1">
              {dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => navigate(d.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  {d.name}
                </button>
              ))}
              {dirs.length === 0 && !error && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No subfolders here.</p>
              )}
            </div>
          </ScrollArea>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onChange(path);
                setOpen(false);
              }}
            >
              Select this folder
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
