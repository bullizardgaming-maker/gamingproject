import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ThumbsUp } from '@phosphor-icons/react';
import { api } from '../api';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';
import { t, type MessageKey } from '../i18n';
import { cn } from '@/lib/utils';
import { GamePicker } from '../components/GamePicker';
import { KNOWN_GAMES } from '@/lib/gameList';
import { isLaunchGame } from '@/lib/launch';

/** Games open for votes: every known game except the ones already at launch. */
const VOTABLE = KNOWN_GAMES.filter((g) => !isLaunchGame(g));

interface Suggestion {
  id: string;
  name: string;
  votes: number;
  status: 'open' | 'planned' | 'added' | 'declined';
  staff_note: string;
  voted: boolean;
}

/** Game voting: suggest a game that is not on the market yet and vote for the ones you want. */
export function GameVotes() {
  usePageMeta({ title: t('votes.title'), description: 'Vote for the games Bullizard should open next.' });
  const { user } = useSession();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Suggestion[]>('/games/votes').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [user?.id]);

  const suggest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/games/votes', { body: { name: name.trim() } });
      setName('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (s: Suggestion) => {
    setError('');
    try {
      const r = await api<{ votes: number }>(`/games/votes/${s.id}/vote`, { body: { on: !s.voted } });
      setItems((all) => (all ?? []).map((x) => (x.id === s.id ? { ...x, votes: r.votes, voted: !s.voted } : x)));
    } catch (err: any) {
      setError(err.message);
    }
  };
  const tone = (st: Suggestion['status']) => (st === 'planned' ? 'held' : st === 'added' ? 'released' : st === 'declined' ? 'disputed' : '');

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div>
        <div className="eyebrow">{t('votes.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('votes.title')}</h1>
        <p className="lede">{t('votes.lede')}</p>
      </div>
      {user ? (
        <form className="card row" style={{ gap: 10, alignItems: 'end', flexWrap: 'wrap' }} onSubmit={suggest}>
          <GamePicker className="m-0 flex-[1_1_280px]" label={t('votes.suggest')} options={VOTABLE} value={name} onChange={setName} placeholder={t('votes.placeholder')} required />
          <button className="btn" disabled={busy || !VOTABLE.some((g) => g.toLowerCase() === name.trim().toLowerCase())}>{t('votes.add')}</button>
        </form>
      ) : (
        <p className="muted"><Link to="/login?next=/games/vote">{t('votes.signIn')}</Link></p>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
      {!items ? (
        <p className="muted">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t('votes.empty')}</p>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0" data-testid="vote-board">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <button
                type="button"
                className={cn('btn', s.voted ? '' : 'ghost')}
                aria-pressed={s.voted}
                aria-label={t('votes.voteFor', { game: s.name })}
                disabled={!user || s.status === 'added' || s.status === 'declined'}
                onClick={() => toggle(s)}
                style={{ minWidth: 86 }}
              >
                <ThumbsUp className="size-4" /> <span className="mono">{s.votes}</span>
              </button>
              <div className="min-w-0" style={{ flex: 1 }}>
                <div className="font-semibold">{s.name}</div>
                {s.staff_note && <div className="small muted">{s.staff_note}</div>}
              </div>
              {s.status !== 'open' && <span className={`chip ${tone(s.status)}`}>{t(`votes.status.${s.status}` as MessageKey)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
