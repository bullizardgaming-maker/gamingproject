import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { t } from '../i18n';

interface Test {
  passMarkPct: number;
  passedAt: string | null;
  attempts: number;
  tier1: boolean;
  questions: Array<{ id: string; position: number; question: string; options: string[] }>;
}
interface Result {
  passed: boolean;
  scorePct: number;
  passMarkPct: number;
  results: Array<{ id: string; correct: boolean; explanation: string | null }>;
}

/**
 * The seller rules test: a short multiple-choice test every seller passes before their first
 * listing. Questions come from the API (staff edit them); a failed attempt shows what was missed.
 */
export function RulesTest({ onPassed }: { onPassed: () => void }) {
  const [test, setTest] = useState<Test | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Test>('/seller/rules-test').then(setTest).catch((e) => setError(e.message));
  }, []);
  if (!test) return <p className="muted">{error || t('rules.loading')}</p>;
  const complete = test.questions.every((q) => q.id in answers);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<Result>('/seller/rules-test', { body: { answers } });
      setResult(r);
      if (r.passed) onPassed();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="rules-title" data-testid="rules-test">
      <h2 id="rules-title" style={{ margin: 0 }}>{t('rules.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('rules.lede', { pct: test.passMarkPct })} <Link to="/help/report-a-user">{t('rules.readRules')}</Link></p>
      {result && (
        <div className={result.passed ? 'ok' : 'alert'} role="status">
          {result.passed ? t('rules.passed', { pct: result.scorePct }) : t('rules.failed', { pct: result.scorePct, need: result.passMarkPct })}
        </div>
      )}
      {test.questions.map((q, i) => {
        const r = result?.results.find((x) => x.id === q.id);
        return (
          <fieldset key={q.id} className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
            <legend style={{ fontWeight: 600 }}>{i + 1}. {q.question}</legend>
            {q.options.map((o, k) => (
              <label key={k} className="row" style={{ alignItems: 'start', gap: 8 }}>
                <input type="radio" name={q.id} value={k} style={{ width: 'auto', marginTop: 4 }} checked={answers[q.id] === k} onChange={() => { setAnswers((a) => ({ ...a, [q.id]: k })); setResult(null); }} />
                <span>{o}</span>
              </label>
            ))}
            {r && !r.correct && <p className="small" style={{ margin: 0, color: 'var(--disputed)' }}>{r.explanation}</p>}
          </fieldset>
        );
      })}
      {error && <div className="alert" role="alert">{error}</div>}
      {!result?.passed && <button className="btn" disabled={!complete || busy}>{busy ? t('rules.checking') : t('rules.submit')}</button>}
    </form>
  );
}
